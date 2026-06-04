import { randomUUID } from "crypto";
import { ConnectionInput, ConnectionProfile } from "./types";

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const CONNECTIONS_KEY = "dbViewer.connections";

export class ProfileStore {
  constructor(
    private readonly globalState: MementoLike,
    private readonly secrets: SecretStorageLike
  ) {}

  list(): ConnectionProfile[] {
    return this.globalState.get<ConnectionProfile[]>(CONNECTIONS_KEY, []).map(normalizeProfile);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  async upsert(input: ConnectionInput, existingId?: string): Promise<ConnectionProfile> {
    const profiles = this.list();
    const existing = existingId ? profiles.find((profile) => profile.id === existingId) : undefined;
    const id = existing?.id ?? randomUUID();
    const passwordSecretKey = existing?.passwordSecretKey ?? `dbViewer.connection.${id}.password`;
    const profile: ConnectionProfile = {
      id,
      name: input.name,
      dbType: input.dbType,
      jdbcUrl: input.jdbcUrl,
      driverClass: input.driverClass,
      driverJarPaths: input.driverJarPaths,
      supportJarPaths: input.supportJarPaths,
      username: input.username,
      passwordSecretKey
    };

    const next = existing
      ? profiles.map((current) => (current.id === id ? profile : current))
      : [...profiles, profile];
    await this.globalState.update(CONNECTIONS_KEY, next);

    if (input.password !== undefined) {
      await this.secrets.store(passwordSecretKey, input.password);
    }

    return profile;
  }

  async delete(id: string): Promise<void> {
    const profiles = this.list();
    const profile = profiles.find((current) => current.id === id);
    await this.globalState.update(
      CONNECTIONS_KEY,
      profiles.filter((current) => current.id !== id)
    );
    if (profile) {
      await this.secrets.delete(profile.passwordSecretKey);
    }
  }

  async getPassword(profile: ConnectionProfile): Promise<string> {
    return (await this.secrets.get(profile.passwordSecretKey)) ?? "";
  }

  async duplicate(profile: ConnectionProfile, password: string): Promise<ConnectionProfile> {
    const baseName = `${profile.name} Copy`;
    const names = new Set(this.list().map((current) => current.name));
    let name = baseName;
    let suffix = 2;
    while (names.has(name)) {
      name = `${baseName} ${suffix}`;
      suffix += 1;
    }

    return this.upsert({
      name,
      dbType: profile.dbType,
      jdbcUrl: profile.jdbcUrl,
      driverClass: profile.driverClass,
      driverJarPaths: profile.driverJarPaths,
      supportJarPaths: profile.supportJarPaths,
      username: profile.username,
      password
    });
  }
}

function normalizeProfile(profile: ConnectionProfile): ConnectionProfile {
  return {
    ...profile,
    dbType: profile.dbType ?? "other",
    supportJarPaths: profile.supportJarPaths ?? []
  };
}
