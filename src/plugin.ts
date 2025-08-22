import type * as lsp from "vscode-languageserver-protocol"
import {EditorView, ViewPlugin, ViewUpdate, showDialog} from "@codemirror/view"
import {ChangeSet, Text, Extension} from "@codemirror/state"
import {language} from "@codemirror/language"
import {type LSPClient} from "./client"
import {docToHTML, withContext} from "./text"
import {toPosition, fromPosition} from "./pos"
import {lspTheme} from "./theme"

/// A plugin that connects a given editor to a language server client.
export class LSPPlugin {
  /// The client connection.
  client: LSPClient
  /// The URI of this file.
  uri: string

  /// @internal
  constructor(
    /// The editor view that this plugin belongs to.
    readonly view: EditorView,
    {client, uri, languageID}: {client: LSPClient, uri: string, languageID?: string}
  ) {
    this.client = client
    this.uri = uri
    if (!languageID) {
      let lang = view.state.facet(language)
      languageID = lang ? lang.name : ""
    }
    client.workspace.openFile(uri, languageID, view)
    this.syncedDoc = view.state.doc
    this.unsyncedChanges = ChangeSet.empty(view.state.doc.length)
  }

  /// Render a doc string from the server to HTML.
  docToHTML(value: string | lsp.MarkupContent, defaultKind: lsp.MarkupKind = "plaintext") {
    let html = withContext(this.view, this.client.config.highlightLanguage, () => docToHTML(value, defaultKind))
    return this.client.config.sanitizeHTML ? this.client.config.sanitizeHTML(html) : html
  }

  /// Convert a CodeMirror document offset into an LSP `{line,
  /// character}` object. Defaults to using the view's current
  /// document, but can be given another one.
  toPosition(pos: number, doc: Text = this.view.state.doc) {
    return toPosition(doc, pos)
  }

  /// Convert an LSP `{line, character}` object to a CodeMirror
  /// document offset.
  fromPosition(pos: lsp.Position, doc: Text = this.view.state.doc) {
    return fromPosition(doc, pos)
  }

  /// Display an error in this plugin's editor.
  reportError(message: string, err: any) {
    showDialog(this.view, {
      label: this.view.state.phrase(message) + ": " + (err.message || err),
      class: "cm-lsp-message cm-lsp-message-error",
      top: true
    })
  }

  /// The version of the document that was synchronized to the server.
  syncedDoc: Text

  /// The changes accumulated in this editor that have not been sent
  /// to the server yet.
  unsyncedChanges: ChangeSet

  /// Reset the [unsynced
  /// changes](#lsp-client.LSPPlugin.unsyncedChanges). Should probably
  /// only be called by a [workspace](#lsp-client.Workspace).
  clear() {
    this.syncedDoc = this.view.state.doc
    this.unsyncedChanges = ChangeSet.empty(this.view.state.doc.length)
  }

  /// @internal
  update(update: ViewUpdate) {
    if (update.docChanged)
      this.unsyncedChanges = this.unsyncedChanges.compose(update.changes)
  }

  /// @internal
  destroy() {
    this.client.workspace.closeFile(this.uri, this.view)
  }

  /// Get the LSP plugin associated with an editor, if any.
  static get(view: EditorView) {
    return view.plugin(lspPlugin)
  }

  /// Create an editor extension that connects that editor to the
  /// given LSP client. This extension is necessary to use LSP-related
  /// functionality exported by this package. Creating an editor with
  /// this plugin will cause
  /// [`openFile`](#lsp-client.Workspace.openFile) to be called on the
  /// workspace.
  ///
  /// By default, the language ID given to the server for this file is
  /// derived from the editor's language configuration via
  /// [`Language.name`](#language.Language.name). You can pass in
  /// a specific ID as a third parameter.
  static create(client: LSPClient, fileURI: string, languageID?: string): Extension {
    return [
      lspPlugin.of({client, uri: fileURI, languageID}),
      lspTheme,
      client.extensions
    ]
  }
}

export const lspPlugin = ViewPlugin.fromClass(LSPPlugin)
