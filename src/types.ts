export type DatabaseType = "oracle" | "postgresql" | "mysql" | "h2" | "other";

export interface ConnectionProfile {
  id: string;
  name: string;
  dbType: DatabaseType;
  jdbcUrl: string;
  driverClass: string;
  driverJarPaths: string[];
  supportJarPaths: string[];
  username: string;
  passwordSecretKey: string;
}

export interface ConnectionInput {
  name: string;
  dbType: DatabaseType;
  jdbcUrl: string;
  driverClass: string;
  driverJarPaths: string[];
  supportJarPaths: string[];
  username: string;
  password?: string;
}

export interface ConnectionSecret {
  password: string;
}

export interface DbSchema {
  name: string;
}

export type DbObjectType = "TABLE" | "VIEW";

export interface DbObject {
  schema: string | null;
  name: string;
  type: DbObjectType;
}

export interface ColumnInfo {
  name: string;
  typeName: string;
  size: number | null;
  nullable: boolean;
  ordinal: number;
  defaultValue: string | null;
  remarks: string | null;
}

export interface ObjectInfo {
  schema: string | null;
  name: string;
  type: DbObjectType;
  columns: ColumnInfo[];
  primaryKeys: string[];
  identifierQuoteString: string;
}

export interface ObjectData {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  limit: number;
  offset: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface ObjectDdl {
  ddl: string | null;
  message: string | null;
}

export type HelperAction =
  | "testConnection"
  | "listSchemas"
  | "listTablesAndViews"
  | "getObjectInfo"
  | "getObjectData"
  | "getObjectDdl";

export interface HelperConnection {
  jdbcUrl: string;
  driverClass: string;
  username: string;
  password: string;
}

export interface HelperRequest {
  action: HelperAction;
  connection: HelperConnection;
  object?: DbObject;
  limit?: number;
  offset?: number;
}

export interface HelperResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}
