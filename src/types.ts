export type Network = "Ethereum" | "ZigChain";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface VaultConfig {
  /** Index from the env key, e.g. "01" for ETH_VAULT_01_*. */
  id: string;
  name: string;
  address: string;
  symbol: string;
  decimals: number;
}

export interface EthereumVaultConfig extends VaultConfig {
  network: "Ethereum";
  /** Lower-cased address used for matching. */
  addressLower: string;
}

export interface ZigVaultConfig extends VaultConfig {
  network: "ZigChain";
}

export interface TelegramConfig {
  botToken: string;
  chatIds: string[];
  dryRun: boolean;
}

export interface EthereumConfig {
  wsUrl: string;
  httpUrl: string;
  vaults: EthereumVaultConfig[];
}

export interface ZigChainConfig {
  rpcUrl: string;
  wsUrl: string;
  /** Optional LCD/REST endpoint for smart queries. Empty = use RPC abci_query. */
  lcdUrl: string;
  pollMs: number;
  vaults: ZigVaultConfig[];
}

export interface AppConfig {
  telegram: TelegramConfig;
  ethereum: EthereumConfig;
  zigchain: ZigChainConfig;
  dedupeTtlMs: number;
  alertExistingMempoolOnStart: boolean;
  logLevel: LogLevel;
}

/** A redeem request decoded from a pending transaction, before quoting. */
export interface RawRedeemRequest {
  network: Network;
  vault: VaultConfig;
  wallet: string;
  txHash: string;
  /** Raw share amount (integer, never converted to asset units). null = not determinable from the tx. */
  shares: bigint | null;
  /** ZigChain only: index of the message inside the tx. */
  messageIndex?: number;
  detectedAt: Date;
}

/** Fully prepared alert. assetAmountRaw === null means quote unavailable. */
export interface RedeemAlert {
  network: Network;
  vaultName: string;
  vaultAddress: string;
  symbol: string;
  decimals: number;
  wallet: string;
  txHash: string;
  shares: bigint | null;
  assetAmountRaw: bigint | null;
  detectedAt: Date;
}

export interface AlertSink {
  send(alert: RedeemAlert): Promise<void>;
}
