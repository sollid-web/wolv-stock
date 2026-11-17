import assert from "node:assert/strict";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { SUPABASE_ROOT_2021_CA, postgresTlsOptions } from "../lib/postgresTls.ts";

test("local development databases connect without TLS", () => {
  assert.equal(postgresTlsOptions("postgresql://u:p@localhost:5432/db", true), false);
});

test("Supabase hosts use full verification with the pinned Supabase root added to Node's roots", () => {
  for (const host of ["aws-0-eu-west-1.pooler.supabase.com", "db.abcdefgh.supabase.co"]) {
    const options = postgresTlsOptions(`postgresql://u:p@${host}:5432/postgres`, false);
    assert.equal(typeof options, "object");
    assert.equal(options.rejectUnauthorized, true);
    assert.ok(options.ca.includes(SUPABASE_ROOT_2021_CA));
    assert.equal(options.ca.length, rootCertificates.length + 1);
  }
});

test("other hosts keep postgres.js verify-full and never disable verification", () => {
  assert.equal(postgresTlsOptions("postgresql://u:p@db.example.com:5432/db", false), "verify-full");
  assert.equal(postgresTlsOptions("postgresql://u:p@evil-supabase.com.example.net:5432/db", false), "verify-full");
  assert.equal(postgresTlsOptions("not a url", false), "verify-full");
});
