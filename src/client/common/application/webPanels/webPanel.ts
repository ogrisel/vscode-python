// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../extensions';

import * as fs from 'fs-extra';
import * as uuid from 'uuid/v4';
import { Uri, Webview, WebviewPanel, window } from 'vscode';

import { Identifiers } from '../../../datascience/constants';
import { IDisposableRegistry } from '../../types';
import * as localize from '../../utils/localize';
import { IWebPanel, IWebPanelOptions, WebPanelMessage } from '../types';

const RemappedPort = 9890;

export class WebPanel implements IWebPanel {

    private panel: WebviewPanel | undefined;
    private loadPromise: Promise<void>;
    private id = uuid();

    constructor(
        private disposableRegistry: IDisposableRegistry,
        private port: number | undefined,
        private token: string | undefined,
        private options: IWebPanelOptions) {
        this.panel = window.createWebviewPanel(
            options.title.toLowerCase().replace(' ', ''),
            options.title,
            { viewColumn: options.viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(this.options.rootPath)],
                portMapping: port ? [{ webviewPort: RemappedPort, extensionHostPort: port }] : undefined
            });
        this.loadPromise = this.load();
    }

    public async show(preserveFocus: boolean) {
        await this.loadPromise;
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn, preserveFocus);
        }
    }

    public updateCwd(_cwd: string) {
        if (this.options.startHttpServer && this.port) {
            // tslint:disable-next-line: no-suspicious-comment
            // TODO: Make a post to the server to indicate this notebook should serve
            // files from the new cwd.
        }
    }

    public close() {
        if (this.panel) {
            this.panel.dispose();
        }
    }

    public isVisible(): boolean {
        return this.panel ? this.panel.visible : false;
    }

    public isActive(): boolean {
        return this.panel ? this.panel.active : false;
    }

    public postMessage(message: WebPanelMessage) {
        if (this.panel && this.panel.webview) {
            this.panel.webview.postMessage(message);
        }
    }

    public get title(): string {
        return this.panel ? this.panel.title : '';
    }

    public set title(newTitle: string) {
        if (this.panel) {
            this.panel.title = newTitle;
        }
    }

    // tslint:disable-next-line:no-any
    private async load() {
        if (this.panel) {
            const localFilesExist = await Promise.all(this.options.scripts.map(s => fs.pathExists(s)));
            if (localFilesExist.every(exists => exists === true)) {

                // Call our special function that sticks this script inside of an html page
                // and translates all of the paths to vscode-resource URIs
                this.panel.webview.html = this.options.startHttpServer ?
                    this.generateServerReactHtml(this.panel.webview) :
                    this.generateLocalReactHtml(this.panel.webview);

                // Reset when the current panel is closed
                this.disposableRegistry.push(this.panel.onDidDispose(() => {
                    this.panel = undefined;
                    this.options.listener.dispose().ignoreErrors();
                }));

                this.disposableRegistry.push(this.panel.webview.onDidReceiveMessage(message => {
                    // Pass the message onto our listener
                    this.options.listener.onMessage(message.type, message.payload);
                }));

                this.disposableRegistry.push(this.panel.onDidChangeViewState((_e) => {
                    // Pass the state change onto our listener
                    this.options.listener.onChangeViewState(this);
                }));

                // Set initial state
                this.options.listener.onChangeViewState(this);
            } else {
                // Indicate that we can't load the file path
                const badPanelString = localize.DataScience.badWebPanelFormatString();
                this.panel.webview.html = badPanelString.format(this.options.scripts.join(', '));
            }
        }
    }

    // tslint:disable-next-line:no-any
    private generateLocalReactHtml(webView: Webview) {
        const uriBase = webView.asWebviewUri(Uri.file(this.options.rootPath));
        const uris = this.options.scripts.map(script => webView.asWebviewUri(Uri.file(script)));

        return `<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
                <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https: http: blob:; default-src 'unsafe-inline' 'unsafe-eval' vscode-resource: data: https: http:;">
                <meta name="theme-color" content="#000000">
                <meta name="theme" content="${Identifiers.GeneratedThemeName}"/>
                <title>React App</title>
                <base href="${uriBase}"/>
            </head>
            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                <div id="root"></div>
                <script type="text/javascript">
                    function resolvePath(relativePath) {
                        if (relativePath && relativePath[0] == '.' && relativePath[1] != '.') {
                            return "${uriBase}" + relativePath.substring(1);
                        }

                        return "${uriBase}" + relativePath;
                    }
                </script>
                ${uris.map(uri => `<script type="text/javascript" src="${uri}"></script>`).join('\n')}
            </body>
        </html>`;
    }

    // tslint:disable-next-line:no-any
    private generateServerReactHtml(webView: Webview) {
        const uriBase = webView.asWebviewUri(Uri.file(this.options.rootPath));
        const relativeScripts = this.options.scripts.map(s => `.${s.substr(this.options.rootPath.length)}`);
        const encoded = relativeScripts.map(s => encodeURIComponent(s.replace(/\\/g, '/')));

        return `<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
                <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https: http: blob:; default-src 'unsafe-inline' 'unsafe-eval' vscode-resource: data: https: http:;">
                <meta name="theme-color" content="#000000">
                <meta name="theme" content="${Identifiers.GeneratedThemeName}"/>
                <title>React App</title>
                <base href="${uriBase}"/>
            </head>
            <body>
                <script type="text/javascript">
                    const vscodeApi = acquireVsCodeApi ? acquireVsCodeApi() : undefined;
                    window.addEventListener('message', (ev) => {
                        const isFromFrame = ev.data && ev.data.command === 'onmessage';
                        if (isFromFrame && vscodeApi) {
                            window.console.log('posting to vscode');
                            window.console.log(JSON.stringify(ev.data.data));
                            vscodeApi.postMessage(ev.data.data);
                        } else if (!isFromFrame) {
                            window.console.log('posting to frame');
                            window.console.log(ev.data.type);
                            const hostFrame = document.getElementById('hostframe');
                            if (hostFrame) {
                                hostFrame.contentWindow.postMessage(ev.data, '*');
                            }
                        }
                    });
                    //# sourceURL=listener.js
                </script>
                <iframe id='hostframe' src="http://localhost:${RemappedPort}/${this.id}?scripts=${encoded.join('%')}&cwd=${this.options.cwd}&rootPath=${this.options.rootPath}&token=${this.token}" frameborder="0" style="left: 0px; display: block; margin: 0px; overflow: hidden; position: absolute; width: 100%; height: 100%; visibility: visible;"/>
            </body>
        </html>`;
    }
}
