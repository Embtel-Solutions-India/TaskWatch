// AUTH-01-AC-8 / SEC-10: directory (dev) sign-in can never be on in production (T-2.2). Pure: no server, no DB.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { devLoginAllowed, engineIntervalMs } from '../src/config.js';

describe('dev login gate', () => {
  it('is off in production whatever else is set', () => {
    assert.equal(devLoginAllowed({ NODE_ENV: 'production' }), false);
    assert.equal(devLoginAllowed({ NODE_ENV: 'production', ALLOW_DEV_LOGIN: 'true' }), false);
  });
  it('outside production: off unless explicitly allowed, so a missing NODE_ENV never falls open', () => {
    assert.equal(devLoginAllowed({}), false);
    assert.equal(devLoginAllowed({ NODE_ENV: 'development' }), false);
    assert.equal(devLoginAllowed({ NODE_ENV: 'development', ALLOW_DEV_LOGIN: 'true' }), true);
    assert.equal(devLoginAllowed({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', ALLOW_DEV_LOGIN: 'true' }), true);
  });
});

describe('engine interval (T-5.5; ESC-08, WO FR-8)', () => {
  it('defaults to 60 s and accepts up to 5 minutes', () => {
    assert.equal(engineIntervalMs({}), 60_000);
    assert.equal(engineIntervalMs({ ENGINE_INTERVAL_MS: '300000' }), 300_000);
  });
  it('refuses to start with an interval over 5 minutes, or a nonsense one', () => {
    for (const v of ['300001', '3600000', '0', 'abc', '1500.5']) assert.throws(() => engineIntervalMs({ ENGINE_INTERVAL_MS: v }), /ENGINE_INTERVAL_MS/, v);
  });
});
