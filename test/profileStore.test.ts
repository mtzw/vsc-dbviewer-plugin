import assert from "node:assert/strict";
import { test } from "node:test";
import { MementoLike, ProfileStore, SecretStorageLike } from "../src/profileStore";

class MemoryMemento implements MementoLike {
  values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class MemorySecrets implements SecretStorageLike {
  values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

test("stores metadata separately from password secrets", async () => {
  const memento = new MemoryMemento();
  const secrets = new MemorySecrets();
  const store = new ProfileStore(memento, secrets);

  const profile = await store.upsert({
    name: "local",
    dbType: "h2",
    jdbcUrl: "jdbc:h2:mem:test",
    driverClass: "org.h2.Driver",
    driverJarPaths: ["/drivers/h2.jar"],
    supportJarPaths: [],
    username: "sa",
    password: "secret"
  });

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].passwordSecretKey, profile.passwordSecretKey);
  assert.equal(store.list()[0].dbType, "h2");
  assert.equal(await store.getPassword(profile), "secret");
  assert.deepEqual(store.list()[0].driverJarPaths, ["/drivers/h2.jar"]);
  assert.deepEqual(store.list()[0].supportJarPaths, []);
});

test("updates existing profiles without changing secret key", async () => {
  const store = new ProfileStore(new MemoryMemento(), new MemorySecrets());
  const profile = await store.upsert({
    name: "local",
    dbType: "h2",
    jdbcUrl: "jdbc:h2:mem:test",
    driverClass: "org.h2.Driver",
    driverJarPaths: ["/drivers/h2.jar"],
    supportJarPaths: [],
    username: "sa",
    password: "secret"
  });

  const updated = await store.upsert({
    name: "renamed",
    dbType: "postgresql",
    jdbcUrl: "jdbc:h2:mem:test2",
    driverClass: "org.h2.Driver",
    driverJarPaths: ["/drivers/h2.jar"],
    supportJarPaths: ["/drivers/support.jar"],
    username: "sa",
    password: "new-secret"
  }, profile.id);

  assert.equal(updated.id, profile.id);
  assert.equal(updated.passwordSecretKey, profile.passwordSecretKey);
  assert.equal(store.list()[0].name, "renamed");
  assert.equal(store.list()[0].dbType, "postgresql");
  assert.deepEqual(store.list()[0].supportJarPaths, ["/drivers/support.jar"]);
  assert.equal(await store.getPassword(updated), "new-secret");
});

test("deletes profiles and their password secret", async () => {
  const secrets = new MemorySecrets();
  const store = new ProfileStore(new MemoryMemento(), secrets);
  const profile = await store.upsert({
    name: "local",
    dbType: "h2",
    jdbcUrl: "jdbc:h2:mem:test",
    driverClass: "org.h2.Driver",
    driverJarPaths: ["/drivers/h2.jar"],
    supportJarPaths: [],
    username: "sa",
    password: "secret"
  });

  await store.delete(profile.id);

  assert.equal(store.list().length, 0);
  assert.equal(await secrets.get(profile.passwordSecretKey), undefined);
});

test("normalizes older profiles without database type", () => {
  const memento = new MemoryMemento();
  memento.values.set("dbViewer.connections", [{
    id: "old",
    name: "legacy",
    jdbcUrl: "jdbc:vendor://localhost/db",
    driverClass: "com.example.Driver",
    driverJarPaths: ["/drivers/vendor.jar"],
    username: "user",
    passwordSecretKey: "secret"
  }]);
  const store = new ProfileStore(memento, new MemorySecrets());

  assert.equal(store.list()[0].dbType, "other");
  assert.deepEqual(store.list()[0].supportJarPaths, []);
});

test("duplicates profiles with a new name and password secret", async () => {
  const store = new ProfileStore(new MemoryMemento(), new MemorySecrets());
  const profile = await store.upsert({
    name: "local",
    dbType: "h2",
    jdbcUrl: "jdbc:h2:mem:test",
    driverClass: "org.h2.Driver",
    driverJarPaths: ["/drivers/h2.jar"],
    supportJarPaths: ["/drivers/support.jar"],
    username: "sa",
    password: "secret"
  });

  const duplicated = await store.duplicate(profile, await store.getPassword(profile));

  assert.notEqual(duplicated.id, profile.id);
  assert.equal(duplicated.name, "local Copy");
  assert.deepEqual(duplicated.supportJarPaths, ["/drivers/support.jar"]);
  assert.equal(await store.getPassword(duplicated), "secret");
});
