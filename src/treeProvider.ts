import * as vscode from "vscode";
import { DbObject, DbObjectType, ConnectionProfile } from "./types";
import { ProfileStore } from "./profileStore";
import { JdbcClient } from "./jdbcClient";

type TreeNode = ConnectionNode | ObjectGroupNode | ObjectNode | MessageNode;

export class ConnectionNode extends vscode.TreeItem {
  constructor(public readonly profile: ConnectionProfile) {
    super(profile.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "connection";
    this.iconPath = new vscode.ThemeIcon("database");
    this.description = profile.username;
    this.tooltip = profile.jdbcUrl;
  }
}

export class ObjectGroupNode extends vscode.TreeItem {
  constructor(
    public readonly profile: ConnectionProfile,
    public readonly type: DbObjectType
  ) {
    super(type === "TABLE" ? "Tables" : "Views", vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = type === "TABLE" ? "tables" : "views";
    this.iconPath = new vscode.ThemeIcon(type === "TABLE" ? "folder" : "folder-library");
  }
}

export class ObjectNode extends vscode.TreeItem {
  constructor(
    public readonly profile: ConnectionProfile,
    public readonly object: DbObject
  ) {
    super(object.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "dbObject";
    this.iconPath = new vscode.ThemeIcon(object.type === "VIEW" ? "eye" : "table");
    this.description = object.type;
    this.command = {
      command: "dbViewer.openObject",
      title: "Open Table or View",
      arguments: [this]
    };
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "message";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class DbTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ProfileStore,
    private readonly client: JdbcClient
  ) {}

  refresh(node?: TreeNode): void {
    this.changed.fire(node);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const profiles = this.store.list();
      return profiles.length > 0
        ? profiles.map((profile) => new ConnectionNode(profile))
        : [new MessageNode("Add a JDBC connection to begin.")];
    }

    if (element instanceof ConnectionNode) {
      return [
        new ObjectGroupNode(element.profile, "TABLE"),
        new ObjectGroupNode(element.profile, "VIEW")
      ];
    }

    if (element instanceof ObjectGroupNode) {
      return this.loadObjects(element.profile, element.type);
    }

    return [];
  }

  private async loadObjects(profile: ConnectionProfile, type: DbObjectType): Promise<TreeNode[]> {
    try {
      const password = await this.store.getPassword(profile);
      const objects = await this.client.request<DbObject[]>(profile, password, "listTablesAndViews", {
        object: { schema: null, name: "", type }
      });
      return objects.length > 0
        ? objects.map((object) => new ObjectNode(profile, object))
        : [new MessageNode(type === "TABLE" ? "No tables found for the connected user." : "No views found for the connected user.")];
    } catch (error) {
      return [new MessageNode((error as Error).message)];
    }
  }
}
