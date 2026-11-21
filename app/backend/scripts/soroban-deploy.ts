import { createHash, createPrivateKey, sign as signManifest } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

interface Args {
  network: 'testnet' | 'mainnet';
  source: string;
  admin?: string;
  wasm: string;
  contractName: string;
  dryRun: boolean;
  registryUrl?: string;
  apiKey?: string;
  mainnetGate?: string;
  testnetManifest?: string;
  auditReport?: string;
  freezeApiUrl?: string;
  freezeOverrideToken?: string;
  freezeOverrideActor?: string;
  freezeOverrideReason?: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      map.set(key, 'true');
    } else {
      map.set(key, next);
      index += 1;
    }
  }

  const network = (map.get('network') ?? 'testnet') as 'testnet' | 'mainnet';
  const source = map.get('source');
  const wasm = map.get('wasm') ?? 'app/contract/target/wasm32-unknown-unknown/release/quickex.wasm';
  const contractName = map.get('contract-name') ?? 'quickex';
  if (!source) {
    throw new Error('--source is required');
  }

  return {
    network,
    source,
    admin: map.get('admin'),
    wasm,
    contractName,
    dryRun: map.get('dry-run') === 'true',
    registryUrl: map.get('registry-url'),
    apiKey: map.get('api-key'),
    mainnetGate: map.get('mainnet-gate'),
    testnetManifest: map.get('testnet-manifest'),
    auditReport: map.get('audit-report'),
    freezeApiUrl: map.get('freeze-api-url') ?? process.env.QUICKEX_DEPLOY_FREEZE_API_URL,
    freezeOverrideToken: map.get('freeze-override-token') ?? process.env.QUICKEX_DEPLOY_FREEZE_OVERRIDE_TOKEN,
    freezeOverrideActor: map.get('freeze-override-actor') ?? process.env.QUICKEX_DEPLOY_FREEZE_OVERRIDE_ACTOR,
    freezeOverrideReason: map.get('freeze-override-reason') ?? process.env.QUICKEX_DEPLOY_FREEZE_OVERRIDE_REASON,
  };
}

interface FreezeState {
  frozen: boolean;
  reason?: string;
  updatedAt?: string;
}

async function fetchFreezeState(apiUrl: string, network: string): Promise<FreezeState> {
  const url = `${apiUrl.replace(/\/$/, '')}/deploy-freeze?network=${encodeURIComponent(network)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Unable to read deploy-freeze state (status ${response.status})`);
  }
  const body = (await response.json()) as Partial<FreezeState>;
  return { frozen: body.frozen === true, reason: body.reason, updatedAt: body.updatedAt };
}

async function assertNotFrozen(args: Args): Promise<void> {
  if (!args.freezeApiUrl) {
    if (args.network === 'mainnet' && !args.dryRun) {
      throw new Error('Mainnet promotion requires --freeze-api-url (or QUICKEX_DEPLOY_FREEZE_API_URL) to verify deploy-freeze state');
    }
    return;
  }

  const state = await fetchFreezeState(args.freezeApiUrl, args.network);
  if (!state.frozen) return;

  if (!args.freezeOverrideToken) {
    throw new Error(
      `Deploy freeze is active for ${args.network}${state.reason ? ` (${state.reason})` : ''}; promotion aborted. ` +
        'Clear the hold or supply --freeze-override-token with --freeze-override-actor and --freeze-override-reason.',
    );
  }
  if (!args.freezeOverrideActor || !args.freezeOverrideReason) {
    throw new Error('Deploy-freeze override requires --freeze-override-actor and --freeze-override-reason');
  }

  const overrideUrl = `${args.freezeApiUrl.replace(/\/$/, '')}/deploy-freeze/override`;
  const response = await fetch(overrideUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Freeze-Override-Token': args.freezeOverrideToken,
    },
    body: JSON.stringify({
      network: args.network,
      actor: args.freezeOverrideActor,
      reason: args.freezeOverrideReason,
      contractName: args.contractName,
    }),
  });
  if (!response.ok) {
    throw new Error(`Deploy-freeze override rejected (status ${response.status})`);
  }
  process.stdout.write(
    `Deploy-freeze override accepted for ${args.network}: actor=${args.freezeOverrideActor} reason=${args.freezeOverrideReason}\n`,
  );
}

function run(command: string, args: string[], dryRun: boolean): string {
  if (dryRun) return [command, ...args].join(' ');
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wasmPath = path.resolve(args.wasm);
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM file not found at ${wasmPath}`);
  }

  const signingKeyId = process.env.QUICKEX_REGISTRY_MANIFEST_KEY_ID;
  const signingKeyPem = process.env.QUICKEX_REGISTRY_MANIFEST_PRIVATE_KEY?.replace(/\\n/g, '\n');
  let registrySigningKey: ReturnType<typeof createPrivateKey> | undefined;
  if (args.registryUrl && (!signingKeyId || !signingKeyPem)) {
    throw new Error('Registry publishing requires QUICKEX_REGISTRY_MANIFEST_KEY_ID and QUICKEX_REGISTRY_MANIFEST_PRIVATE_KEY');
  }
  if (args.registryUrl) {
    try {
      registrySigningKey = createPrivateKey(signingKeyPem!);
    } catch {
      throw new Error('QUICKEX_REGISTRY_MANIFEST_PRIVATE_KEY must be a valid Ed25519 private-key PEM');
    }
    if (registrySigningKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('QUICKEX_REGISTRY_MANIFEST_PRIVATE_KEY must use Ed25519');
    }
  }
  await assertNotFrozen(args);

  if (args.network === 'mainnet' && !args.dryRun) {
    if (!args.mainnetGate || !args.testnetManifest || !args.auditReport) {
      throw new Error('Mainnet deployment requires --mainnet-gate, --testnet-manifest, and --audit-report');
    }
    execFileSync(process.execPath, [
      path.resolve(__dirname, '../../..', 'scripts/verify-mainnet-deployment-gate.js'),
      '--gate', path.resolve(args.mainnetGate),
      '--testnet-manifest', path.resolve(args.testnetManifest),
      '--audit-report', path.resolve(args.auditReport),
      '--wasm', wasmPath,
    ], { stdio: 'inherit' });
  }

  const networkPassphrase =
    args.network === 'mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';
  const wasmHash = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
  const installCommand = ['contract', 'install', '--network', args.network, '--source', args.source, '--wasm', wasmPath];
  const deployCommand = ['contract', 'deploy', '--network', args.network, '--source', args.source, '--wasm-hash', wasmHash];

  const installResult = run('soroban', installCommand, args.dryRun);
  const contractId = run('soroban', deployCommand, args.dryRun) || '<contract-id>';

  let initResult: string | null = null;
  if (args.admin) {
    initResult = run(
      'soroban',
      ['contract', 'invoke', '--network', args.network, '--source', args.source, '--id', contractId, '--', 'initialize', args.admin],
      args.dryRun,
    );
  }

  const artifact = {
    deployedAt: new Date().toISOString(),
    network: args.network,
    networkPassphrase,
    contractName: args.contractName,
    contractId,
    wasmHash,
    installResult,
    initResult,
  };

  const outputDir = path.resolve('app/backend/deployments');
  mkdirSync(outputDir, { recursive: true });
  const artifactPath = path.join(outputDir, `${args.network}-${args.contractName}.json`);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  if (args.registryUrl) {
    const publication = {
      networkPassphrase,
      deploymentId: `${args.network}-${args.contractName}-${Date.now()}`,
      manifestTimestamp: new Date().toISOString(),
      contracts: [
        {
          name: args.contractName,
          contractId,
          wasmHash,
          contractVersion: 1,
          metadata: {
            artifactPath,
            dryRun: args.dryRun,
          },
        },
      ],
    };
    const manifestSignature = signManifest(
      null,
      Buffer.from(canonicalJson(publication)),
      registrySigningKey!,
    ).toString('base64');
    const response = await fetch(`${args.registryUrl.replace(/\/$/, '')}/contracts/registry/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.apiKey ? { 'X-API-Key': args.apiKey } : {}),
      },
      body: JSON.stringify({
        ...publication,
        manifestKeyId: signingKeyId,
        manifestSignature,
      }),
    });

    if (!response.ok) {
      throw new Error(`Registry publish failed with status ${response.status}`);
    }
  }

  process.stdout.write(`${JSON.stringify({ artifactPath, artifact }, null, 2)}\n`);
}

if (require.main === module) {
  void main();
}

export { parseArgs, assertNotFrozen, fetchFreezeState };
