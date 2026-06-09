import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTemporalInputValue, updateInputType, validateValue } from "../src/valueValidation";

test("validates integer and decimal values", () => {
  assert.equal(validateValue({ name: "ID", jdbcType: 4, typeName: "INTEGER", nullable: false }, "123"), null);
  assert.equal(validateValue({ name: "ID", jdbcType: 4, typeName: "INTEGER", nullable: false }, "12.3"), "整数を入力してください。");
  assert.equal(validateValue({ name: "AMOUNT", jdbcType: 3, typeName: "DECIMAL", nullable: false }, "12.30"), null);
  assert.equal(validateValue({ name: "AMOUNT", jdbcType: 3, typeName: "DECIMAL", nullable: false }, "abc"), "数値を入力してください。");
});

test("validates boolean values", () => {
  assert.equal(validateValue({ name: "ACTIVE", jdbcType: 16, typeName: "BOOLEAN", nullable: false }, "true"), null);
  assert.equal(validateValue({ name: "ACTIVE", jdbcType: 16, typeName: "BOOLEAN", nullable: false }, "0"), null);
  assert.equal(validateValue({ name: "ACTIVE", jdbcType: 16, typeName: "BOOLEAN", nullable: false }, "maybe"), "true/false、1/0、yes/noのいずれかを入力してください。");
});

test("validates temporal values", () => {
  assert.equal(validateValue({ name: "BIRTH_DATE", jdbcType: 91, typeName: "DATE", nullable: false }, "2026-06-09"), null);
  assert.equal(validateValue({ name: "BIRTH_DATE", jdbcType: 91, typeName: "DATE", nullable: false }, "2026/06/09"), "日付はyyyy-mm-dd形式で入力してください。");
  assert.equal(validateValue({ name: "START_TIME", jdbcType: 92, typeName: "TIME", nullable: false }, "09:30:00"), null);
  assert.equal(validateValue({ name: "START_TIME", jdbcType: 92, typeName: "TIME", nullable: false }, "09-30-00"), "時刻はHH:mm:ss形式で入力してください。");
  assert.equal(validateValue({ name: "CREATED_AT", jdbcType: 93, typeName: "TIMESTAMP", nullable: false }, "2026-06-09T09:30:00"), null);
  assert.equal(validateValue({ name: "CREATED_AT", jdbcType: 93, typeName: "TIMESTAMP", nullable: false }, "2026-06-09"), "日時はyyyy-mm-dd HH:mm:ssまたはyyyy-mm-ddTHH:mm:ss形式で入力してください。");
});

test("validates nullability", () => {
  assert.equal(validateValue({ name: "NOTE", jdbcType: 12, typeName: "VARCHAR", nullable: true }, null), null);
  assert.equal(validateValue({ name: "NAME", jdbcType: 12, typeName: "VARCHAR", nullable: false }, null), "NULLは指定できません。");
});

test("selects update input type for temporal columns", () => {
  assert.equal(updateInputType({ name: "D", jdbcType: 91, typeName: "DATE", nullable: true }), "date");
  assert.equal(updateInputType({ name: "T", jdbcType: 92, typeName: "TIME", nullable: true }), "time");
  assert.equal(updateInputType({ name: "TS", jdbcType: 93, typeName: "TIMESTAMP", nullable: true }), "datetime-local");
  assert.equal(updateInputType({ name: "TSTZ", jdbcType: 2014, typeName: "TIMESTAMP WITH TIME ZONE", nullable: true }), "text");
});

test("normalizes temporal input values for browser controls", () => {
  assert.equal(normalizeTemporalInputValue({ name: "D", jdbcType: 91, typeName: "DATE", nullable: true }, "2026-06-09 12:00:00"), "2026-06-09");
  assert.equal(normalizeTemporalInputValue({ name: "T", jdbcType: 92, typeName: "TIME", nullable: true }, "09:30:00"), "09:30:00");
  assert.equal(normalizeTemporalInputValue({ name: "TS", jdbcType: 93, typeName: "TIMESTAMP", nullable: true }, "2026-06-09 09:30:00.0"), "2026-06-09T09:30:00");
});
