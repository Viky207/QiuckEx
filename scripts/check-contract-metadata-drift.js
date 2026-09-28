const fs = require('fs');
const path = require('path');
const toml = require('toml');

const ROOT = path.resolve(__dirname, '..');
const PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

function validateRegistry(registry, sourceVersions) {
  if (registry.application !== 'quickex') {
    throw new Error('Environment registry application must be quickex');
  }

  const deployments = new Map();
  for (const network of Object.keys(PASSPHRASES)) {
    const environment = registry.environments?.[network];
    if (!environment || environment.network !== network) {
      throw new Error(`Missing or mismatched ${network} environment registry entry`);
    }
    if (environment.network_passphrase !== PASSPHRASES[network]) {
      throw new Error(`${network} network passphrase does not match the Stellar network`);
    }

    const contracts = environment.contracts ?? [];
    if (!Array.isArray(contracts)) {
      throw new Error(`${network} contracts must be an array`);
    }
    if (contracts.length === 0) {
      if (network !== 'mainnet' || environment.mainnet_gated !== true) {
        throw new Error(`${network} has no contract metadata and is not explicitly gated`);
      }
      continue;
    }

    for (const contract of contracts) {
      if (!Number.isInteger(contract.contract_version) || contract.contract_version < 1) {
        throw new Error(`${network}/${contract.name} is missing a valid contract_version`);
      }
      if (!Number.isInteger(contract.event_schema_version) || contract.event_schema_version < 1) {
        throw new Error(`${network}/${contract.name} is missing a valid event_schema_version`);
      }
      if (!/^0x[a-fA-F0-9]{64}$/.test(contract.wasm_hash ?? '')) {
        throw new Error(`${network}/${contract.name} has an invalid wasm_hash`);
      }
      if (!/^C[A-Z0-9]{55}$/.test(contract.contract_id ?? '')) {
        throw new Error(`${network}/${contract.name} has an invalid contract_id`);
      }
      if (contract.contract_version !== sourceVersions.contractVersion) {
        throw new Error(`${network}/${contract.name} contract_version ${contract.contract_version} drifts from source ${sourceVersions.contractVersion}`);
      }
      if (contract.event_schema_version !== sourceVersions.eventSchemaVersion) {
        throw new Error(`${network}/${contract.name} event_schema_version ${contract.event_schema_version} drifts from source ${sourceVersions.eventSchemaVersion}`);
      }
      deployments.set(`${network}:${contract.name}`, { network, ...contract });
    }
  }

  const testnetContracts = registry.environments.testnet.contracts ?? [];
  const mainnetContracts = registry.environments.mainnet.contracts ?? [];
  for (const testnet of testnetContracts) {
    const mainnet = mainnetContracts.find((entry) => entry.name === testnet.name);
    if (!mainnet) continue;
    for (const field of ['contract_version', 'event_schema_version', 'wasm_hash']) {
      if (testnet[field] !== mainnet[field]) {
        throw new Error(`Cross-network ${testnet.name} ${field} drift: testnet=${testnet[field]}, mainnet=${mainnet[field]}`);
      }
    }
    if (testnet.contract_id === mainnet.contract_id) {
      throw new Error(`Cross-network ${testnet.name} contract_id must be network-specific`);
    }
  }

  return deployments.size;
}

function readSourceVersions() {
  const storage = fs.readFileSync(path.join(ROOT, 'app/contract/contracts/quickex/src/storage.rs'), 'utf8');
  const events = fs.readFileSync(path.join(ROOT, 'app/contract/contracts/quickex/src/events.rs'), 'utf8');
  const contractVersion = storage.match(/pub const CURRENT_CONTRACT_VERSION: u32 = (\d+);/);
  const eventSchemaVersion = events.match(/pub const EVENT_SCHEMA_VERSION: u32 = (\d+);/);
  if (!contractVersion || !eventSchemaVersion) {
    throw new Error('Could not read contract metadata version constants from source');
  }
  return {
    contractVersion: Number(contractVersion[1]),
    eventSchemaVersion: Number(eventSchemaVersion[1]),
  };
}

function main() {
  const registryPath = path.join(ROOT, 'app/contract/documentation/environment-registry.toml');
  const registry = toml.parse(fs.readFileSync(registryPath, 'utf8'));
  const deployedCount = validateRegistry(registry, readSourceVersions());
  console.log(`Contract metadata drift check passed (${deployedCount} deployment record(s); gated networks excluded).`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Contract metadata drift check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateRegistry };