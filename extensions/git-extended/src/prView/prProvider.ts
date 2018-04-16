/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { parseDiff, DIFF_HUNK_INFO } from '../common/diff';
import { Repository } from '../common//models/repository';
import { Comment } from '../common/models/comment';
import * as _ from 'lodash';
import { Configuration } from '../configuration';
import { parseComments } from '../common/comment';
import { PRGroupTreeItem, FileChangeTreeItem } from '../common/treeItems';
import { Resource } from '../common/resources';
import { ReviewMode } from '../review/reviewMode';
import { toPRUri } from '../common/uri';
import * as fs from 'fs';
import { PullRequest, PRType } from '../common/models/pullrequest';

export class PRProvider implements vscode.TreeDataProvider<PRGroupTreeItem | PullRequest | FileChangeTreeItem>, vscode.TextDocumentContentProvider {
	private context: vscode.ExtensionContext;
	private repository: Repository;
	private configuration: Configuration;
	private reviewMode: ReviewMode;
	private _onDidChangeTreeData = new vscode.EventEmitter<PRGroupTreeItem | PullRequest | FileChangeTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }

	constructor(context: vscode.ExtensionContext, configuration: Configuration, reviewMode: ReviewMode) {
		this.context = context;
		this.configuration = configuration;
		this.reviewMode = reviewMode;
		vscode.workspace.registerTextDocumentContentProvider('pr', this);
	}

	async activate(repository: Repository) {
		this.repository = repository;
		this.context.subscriptions.push(vscode.window.registerTreeDataProvider<PRGroupTreeItem | PullRequest | FileChangeTreeItem>('pr', this));
		this.context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PullRequest) => {
			await this.reviewMode.switch(pr);
		}));
		this.context.subscriptions.push(this.configuration.onDidChange(e => {
			this._onDidChangeTreeData.fire();
		}));
	}

	getTreeItem(element: PRGroupTreeItem | PullRequest | FileChangeTreeItem): vscode.TreeItem {
		if (element instanceof PRGroupTreeItem) {
			return element;
		}

		if (element instanceof PullRequest) {
			return {
				label: element.prItem.title,
				collapsibleState: 1,
				contextValue: 'pullrequest',
				iconPath: Resource.getGravatarUri(element)
			};
		} else {
			element.iconPath = Resource.getFileStatusUri(element);
			return element;
		}
	}

	async getChildren(element?: PRGroupTreeItem | PullRequest | FileChangeTreeItem): Promise<(PRGroupTreeItem | PullRequest | FileChangeTreeItem)[]> {
		if (!element) {
			return Promise.resolve([
				new PRGroupTreeItem(PRType.RequestReview),
				new PRGroupTreeItem(PRType.Mine),
				new PRGroupTreeItem(PRType.All)
			]);
		}

		if (!this.repository.remotes || !this.repository.remotes.length) {
			return Promise.resolve([]);
		}

		if (element instanceof PRGroupTreeItem) {
			return this.getPRs(element);
		}

		if (element instanceof PullRequest) {
			const comments = await element.getComments();
			const data = await element.getFiles();
			const baseSha = await element.getBaseCommitSha();
			const richContentChanges = await parseDiff(data, this.repository, baseSha);
			const commentsCache = new Map<String, Comment[]>();
			let fileChanges = richContentChanges.map(change => {
				let fileInRepo = path.resolve(this.repository.path, change.fileName);
				let changedItem = new FileChangeTreeItem(
					element.prItem,
					change.fileName,
					change.status,
					this.context,
					change.fileName,
					toPRUri(vscode.Uri.file(change.filePath), fileInRepo, change.fileName, true),
					toPRUri(vscode.Uri.file(change.originalFilePath), fileInRepo, change.fileName, false),
					this.repository.path,
					change.patch
				);
				changedItem.comments = comments.filter(comment => comment.path === changedItem.fileName);
				commentsCache.set(changedItem.filePath.toString(), changedItem.comments);
				return changedItem;
			});

			vscode.commands.registerCommand('diff-' + element.prItem.number + '-post', async (id: string, uri: vscode.Uri, lineNumber: number, text: string) => {
				if (id) {
					try {
						let ret = await element.createCommentReply(text, id);
						return {
							body: new vscode.MarkdownString(ret.data.body),
							userName: ret.data.user.login,
							gravatar: ret.data.user.avatar_url
						};
					} catch (e) {
						return null;
					}
				} else {
					let params = JSON.parse(uri.query);

					let fileChange = richContentChanges.find(change => change.fileName === params.fileName);
					let regex = new RegExp(DIFF_HUNK_INFO, 'g');
					let matches = regex.exec(fileChange.patch);

					let position;
					while (matches) {
						let newStartLine = Number(matches[5]);
						let newLen = Number(matches[7]) | 0;

						if (lineNumber >= newStartLine && lineNumber <= newStartLine + newLen - 1) {
							position = lineNumber - newStartLine + 1;
							break;
						}

						matches = regex.exec(fileChange.patch);
					}

					if (!position) {
						return;
					}

					// there is no thread Id, which means it's a new thread
					let ret = await element.createComment(text, params.fileName, position);
					return {
						body: new vscode.MarkdownString(ret.data.body),
						userName: ret.data.user.login,
						gravatar: ret.data.user.avatar_url
					};
				}
			});

			let actions = [
				{
					command: 'diff-' + element.prItem.number + '-post',
					title: 'Add single comment'
				}
			];

			vscode.workspace.registerCommentProvider({
				provideNewCommentRange: async (document: vscode.TextDocument, token: vscode.CancellationToken) => {
					if (document.uri.scheme === 'pr') {
						let params = JSON.parse(document.uri.query);
						let fileChange = richContentChanges.find(change => change.fileName === params.fileName);
						let regex = new RegExp(DIFF_HUNK_INFO, 'g');
						let matches = regex.exec(fileChange.patch);

						let ret: vscode.Range[] = [];
						while (matches) {
							let newStartLine = Number(matches[5]);
							let newLen = Number(matches[7]) | 0;

							ret.push(new vscode.Range(
								newStartLine - 1,
								0,
								newStartLine + newLen - 1 - 1,
								document.lineAt(newStartLine + newLen - 1 - 1).text.length
							));

							matches = regex.exec(fileChange.patch);
						}

						return {
							ranges: ret,
							actions: actions
						};
					}

					return null;
				},
				provideComments: async (document: vscode.TextDocument, token: vscode.CancellationToken) => {
					if (document.uri.scheme === 'pr') {
						let matchingComments = commentsCache.get(document.uri.toString());

						if (!matchingComments || !matchingComments.length) {
							return [];
						}

						let sections = _.groupBy(matchingComments, comment => comment.position);
						let ret: vscode.CommentThread[] = [];

						for (let i in sections) {
							let comments = sections[i];

							const comment = comments[0];
							const commentAbsolutePosition = comment.diff_hunk_range.start + (comment.position - 1);
							const pos = new vscode.Position(comment.currentPosition ? comment.currentPosition - 1 - 1 : commentAbsolutePosition - /* after line */ 1 - /* it's zero based*/ 1, 0);
							const range = new vscode.Range(pos, pos);

							ret.push({
								threadId: comment.id,
								range,
								comments: comments.map(comment => {
									return {
										body: new vscode.MarkdownString(comment.body),
										userName: comment.user.login,
										gravatar: comment.user.avatar_url
									};
								}),
								actions: actions
							});
						}

						return ret;

					}

					return [];
				}
			});
			// fill in file changes and comments.
			element.comments = comments;
			element.fileChanges = fileChanges;
			return fileChanges;
		}
	}

	async getPRs(element: PRGroupTreeItem): Promise<PullRequest[]> {
		let promises = this.repository.githubRepositories.map(async githubRepository => {
			return await githubRepository.getPullRequests(element.type);
		});

		return Promise.all(promises).then(values => {
			return _.flatten(values);
		});
	}

	async getComments(element: PullRequest): Promise<Comment[]> {
		const reviewData = await element.otcokit.pullRequests.getComments({
			owner: element.remote.owner,
			repo: element.remote.name,
			number: element.prItem.number
		});
		const rawComments = reviewData.data;
		return parseComments(rawComments);
	}


	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		let { path } = JSON.parse(uri.query);
		try {
			let content = fs.readFileSync(path);
			return content.toString();
		} catch (e) {
			return '';
		}
	}

}
