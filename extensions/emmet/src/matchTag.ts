/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HtmlNode } from 'EmmetNode';
import { getNode, parseDocument, validate, allowedMimeTypesInScriptTag } from './util';
import { DocumentStreamReader } from './bufferStream';
import parse from '@emmetio/html-matcher';

export function matchTag() {
	if (!validate(false) || !vscode.window.activeTextEditor) {
		return;
	}
	const editor = vscode.window.activeTextEditor;

	let rootNode = <HtmlNode>parseDocument(editor.document);
	if (!rootNode) {
		return;
	}

	let updatedSelections: vscode.Selection[] = [];
	editor.selections.forEach(selection => {
		let updatedSelection = getUpdatedSelections(editor, selection.start, rootNode);
		if (updatedSelection) {
			updatedSelections.push(updatedSelection);
		}
	});
	if (updatedSelections.length > 0) {
		editor.selections = updatedSelections;
		editor.revealRange(editor.selections[updatedSelections.length - 1]);
	}
}

function getUpdatedSelections(editor: vscode.TextEditor, position: vscode.Position, rootNode: HtmlNode): vscode.Selection | undefined {
	const currentNode = <HtmlNode>getNode(rootNode, position, true);
	if (!currentNode || !currentNode.close) {
		return;
	}

	// If cursor is between open and close tag, then no-op
	// Unless its a script tag with html content, in which case re-parse it
	// Due to https://github.com/emmetio/html-matcher/issues/2
	if (position.isAfter(currentNode.open.end) && position.isBefore(currentNode.close.start)) {
		if (currentNode.name === 'script'
			&& currentNode.attributes
			&& currentNode.attributes.some(x => x.name.toString() === 'type'
				&& allowedMimeTypesInScriptTag.indexOf(x.value.toString()) > -1)) {
			const buffer = new DocumentStreamReader(editor.document, currentNode.open.end, new vscode.Range(currentNode.open.end, currentNode.close.start));
			const scriptNode = <HtmlNode>parse(buffer);
			return getUpdatedSelections(editor, position, scriptNode);
		}
		return;
	}

	// Place cursor inside the close tag if cursor is inside the open tag, else place it inside the open tag
	let finalPosition = position.isBeforeOrEqual(currentNode.open.end) ? currentNode.close.start.translate(0, 2) : currentNode.open.start.translate(0, 1);
	return new vscode.Selection(finalPosition, finalPosition);
}


