const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRegistry } = require('./check-contract-metadata-drift');

const versions = { contractVersion: 1, eventSchemaVersion: 2 };

function registry(mainnetContracts = []) {
  const contract = (contractId) => ({
    name: 'quickex',
    contract_id: contractId,
    wasm_hash: `0x${'a'.repeat(64)}`,
    contract_version: 1,
    event_schema_version: 2,
  });
  return {
    application: 'quickex',
    environments: {
      testnet: {
        network: 'testnet',
        network_passphrase: 'Test SDF Network ; September 2015',
        contracts: [contract(`C${'A'.repeat(55)}`)],
      },
      mainnet: {
        network: 'mainnet',
        network_passphrase: 'Public Global Stellar Network ; September 2015',
        mainnet_gated: mainnetContracts.length === 0,
        contracts: mainnetContracts.length ? [contract(`C${'B'.repeat(55)}`)] : [],
      },
    },
  };
}

test('allows aligned metadata and an explicitly gated mainnet', () => {
  assert.equal(validateRegistry(registry(), versions), 1);
});

test('rejects metadata drift between deployed networks', () => {
  const value = registry([{}]);
  value.environments.mainnet.contracts[0].event_schema_version = 3;
  assert.throws(() => validateRegistry(value, versions), /event_schema_version/);
});

test('rejects metadata that has drifted from contract source', () => {
  const value = registry();
  value.environments.testnet.contracts[0].contract_version = 0;
  assert.throws(() => validateRegistry(value, versions), /contract_version/);
});

test('does not allow a missing ungated mainnet deployment', () => {
  const value = registry();
  value.environments.mainnet.mainnet_gated = false;
  assert.throws(() => validateRegistry(value, versions), /not explicitly gated/);
});