import { SorobanErrorCode } from '../common/soroban-errors';

export const TESTNET_CONTRACT_WRITES_FLAG = 'testnet.contract_writes';
export const MAINNET_DISPUTE_ACTIONS_FLAG = 'mainnet.dispute_actions';

/**
 * Gates the operator replay surface on mainnet (issue #278). Replay re-sends a
 * customer notification, so on mainnet it must be enabled deliberately by an
 * admin rather than being available by default.
 */
export const MAINNET_OPERATOR_REPLAY_FLAG = 'mainnet.operator_replay';

export const CONTRACT_WRITES_DISABLED_CODE =
  SorobanErrorCode.CONTRACT_WRITES_DISABLED;

export const CONTRACT_WRITES_DISABLED_MESSAGE =
  'Contract write operations are temporarily disabled on testnet. Retry after the incident is resolved or consult the status page.';

export const DISPUTE_ACTIONS_DISABLED_CODE =
  SorobanErrorCode.DISPUTE_ACTIONS_DISABLED;

export const DISPUTE_ACTIONS_DISABLED_MESSAGE =
  'Escrow dispute actions are disabled on mainnet. Enable the mainnet.dispute_actions flag to proceed.';
