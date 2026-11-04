import { parseAbi } from "viem";

export const floatAbi = parseAbi([
  "function release(address recipient, uint256 amount, bytes32 ref)",
  "function refUsed(bytes32 ref) view returns (bool)",
  "function floatBalance() view returns (uint256)",
  "function paused() view returns (bool)",
  "function maxPerTx() view returns (uint256)",
  "function maxPerAddressPerDay() view returns (uint256)",
  "function maxGlobalPerDay() view returns (uint256)",
  "function globalSpentToday() view returns (uint256)",
  "function addressSpentToday(address recipient) view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event Released(bytes32 indexed ref, address indexed recipient, uint256 amount)",
]);

export const depositAbi = parseAbi([
  "event Deposit(uint256 indexed nonce, bytes32 indexed id, address indexed sender, address token, uint256 amount, address recipient)",
  "function tokenConfig(address token) view returns (bool enabled, uint256 minAmount, uint256 maxAmount)",
  "function paused() view returns (bool)",
  "function treasury() view returns (address)",
  "function deposit(address token, uint256 amount, address recipient) returns (bytes32)",
  "function depositNative(address recipient) payable returns (bytes32)",
]);

export const oracleAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const pegGuardAbi = parseAbi([
  "function status() view returns (bool healthy, uint256 stableBps, uint256 usdtBps, uint256 btcBps)",
  "function isHealthy() view returns (bool)",
]);

export const rebalancerAbi = parseAbi([
  "function rebalance(uint8 route, uint256 amountIn, uint256 minOut) returns (uint256 received)",
  "function routes(uint8 route) view returns (address pool, address tokenIn, address tokenOut, uint8 decimalsIn, uint8 decimalsOut, uint256 maxIn, uint256 maxSlippageBps)",
  "function treasury() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event Rebalanced(address indexed keeper, uint8 indexed route, uint256 amountIn, uint256 amountOut)",
]);

export const refillerAbi = parseAbi([
  "function refill(address float, uint256 amount)",
  "function floats(address float) view returns (address token, uint256 maxPerCall)",
  "function treasury() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event Refilled(address indexed keeper, address indexed float, address indexed token, uint256 amount)",
]);

export const poolAbi = parseAbi(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);
