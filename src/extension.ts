import * as vscode from "vscode";
import { ConnectionEditorPanel } from "./connectionEditorPanel";
import { JdbcClient } from "./jdbcClient";
import { ObjectPanel } from "./objectPanel";
import { ProfileStore } from "./profileStore";
import { ConnectionProfile } from "./types";
import { ConnectionNode, DbTreeProvider, ObjectNode } from "./treeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProfileStore(context.globalState, context.secrets);
  const client = new JdbcClient(context.extensionPath);
  const treeProvider = new DbTreeProvider(store, client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("dbViewer.connections", treeProvider),
    vscode.commands.registerCommand("dbViewer.refresh", () => treeProvider.refresh()),
    vscode.commands.registerCommand("dbViewer.addConnection", async () => {
      const input = await ConnectionEditorPanel.open(context, client);
      if (!input) {
        return;
      }
      const profile = await store.upsert(input);
      vscode.window.showInformationMessage(`Connection "${profile.name}" saved.`);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand("dbViewer.editConnection", async (node?: ConnectionNode) => {
      const profile = node?.profile ?? await pickProfile(store);
      if (!profile) {
        return;
      }
      const input = await ConnectionEditorPanel.open(context, client, profile, await store.getPassword(profile));
      if (!input) {
        return;
      }
      const updated = await store.upsert(input, profile.id);
      vscode.window.showInformationMessage(`Connection "${updated.name}" saved.`);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand("dbViewer.duplicateConnection", async (node?: ConnectionNode) => {
      const profile = node?.profile ?? await pickProfile(store);
      if (!profile) {
        return;
      }
      const duplicated = await store.duplicate(profile, await store.getPassword(profile));
      vscode.window.showInformationMessage(`Connection "${profile.name}" duplicated as "${duplicated.name}".`);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand("dbViewer.deleteConnection", async (node?: ConnectionNode) => {
      const profile = node?.profile ?? await pickProfile(store);
      if (!profile) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete connection "${profile.name}"?`,
        { modal: true },
        "Delete"
      );
      if (answer === "Delete") {
        await store.delete(profile.id);
        treeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand("dbViewer.openObject", async (node?: ObjectNode) => {
      if (!node) {
        vscode.window.showInformationMessage("Select a table or view from DB Viewer.");
        return;
      }
      await ObjectPanel.open(context, store, client, node.profile, node.object);
    })
  );
}

export function deactivate(): void {
  // No long-running resources are retained between commands.
}

async function pickProfile(store: ProfileStore): Promise<ConnectionProfile | undefined> {
  const picked = await vscode.window.showQuickPick(
    store.list().map((profile) => ({ label: profile.name, description: profile.jdbcUrl, profile })),
    { title: "Select connection" }
  );
  return picked?.profile;
}
