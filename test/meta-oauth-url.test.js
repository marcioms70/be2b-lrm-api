import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizationUrl } from "../src/metaOauthUrl.js";

const base = {
  version: "v21.0",
  appId: "123",
  redirectUri: "https://api.exemplo.com/api/meta-ads/oauth/callback",
  state: "abc.def",
  scopes: ["ads_management", "ads_read"],
};

test("sem config_id: login clássico, permissões na URL (comportamento anterior)", () => {
  const u = buildAuthorizationUrl(base);
  assert.equal(u.origin + u.pathname, "https://www.facebook.com/v21.0/dialog/oauth");
  assert.equal(u.searchParams.get("scope"), "ads_management,ads_read");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("config_id"), null);
  assert.equal(u.searchParams.get("override_default_response_type"), null);
});

test("com config_id: Login para Empresas, SEM scope e pedindo code", () => {
  const u = buildAuthorizationUrl({ ...base, configId: "987654321" });
  assert.equal(u.searchParams.get("config_id"), "987654321");
  assert.equal(u.searchParams.get("override_default_response_type"), "true");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.has("scope"), false);
});

test("config_id vazio ou só espaços volta ao modo clássico", () => {
  for (const configId of ["", "   ", undefined, null]) {
    const u = buildAuthorizationUrl({ ...base, configId });
    assert.equal(u.searchParams.has("config_id"), false);
    assert.equal(u.searchParams.get("scope"), "ads_management,ads_read");
  }
});

test("mantém client_id, redirect_uri e state intactos nos dois modos", () => {
  for (const configId of ["", "42"]) {
    const u = buildAuthorizationUrl({ ...base, configId });
    assert.equal(u.searchParams.get("client_id"), "123");
    assert.equal(u.searchParams.get("redirect_uri"), base.redirectUri);
    assert.equal(u.searchParams.get("state"), "abc.def");
  }
});
