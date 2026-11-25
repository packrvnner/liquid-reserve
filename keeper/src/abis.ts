// Minimal human-readable ABIs for the contracts the keeper drives.

// (Error(string) and Panic(uint256) are built in; tx.ts decodes them by selector.)
export const ERRORS = [
  // nothing-to-do
  "error NothingToAllocate()",
  "error NothingToRoute()",
  "error NothingToPay()",
  "error NothingToDistribute()",
  "error NothingToForward()",
  "error NothingToStake()",
  "error NothingToUnstake()",
  "error NothingToBridge()",
  "error BelowMinimum(uint256 amount, uint256 minAmount)",
  "error TargetNotSet()",
  "error RecipientNotSet()",
  "error ZeroAmount()",
  // Uniswap v4 wraps hook reverts: target = hook, reason = the hook's own revert data
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error NotCalm(int24 tick, int24 twapTick)",
  // price / liquidity
  "error InsufficientOutput(uint256 received, uint256 minOut)",
  "error QuoteZero(address tokenIn, address tokenOut, uint256 amountIn)",
  "error PartialFill(uint256 hopIndex, uint256 paid, uint256 expected)",
  "error StalePrice(bytes32 id)",
  "error InsufficientHistory(bytes32 id)",
  "error NoRoute(address tokenIn, address tokenOut)",
  "error UnexpectedDelta(uint256 hopIndex)",
  "error AmountTooLarge()",
  // access / config
  "error NotKeeper()",
  "error UnknownFeed(bytes32 id)",
  "error GasTooLow()",
  "error ZeroRate(address asset)",
  "error IsReserveAsset(address token)",
  "error NotReserveAsset(address token)",
];

export const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const ORACLE = [
  "function poke(bytes32[] ids)",
  "function isKeeper(address) view returns (bool)",
  "function maxStaleness() view returns (uint32)",
  "function feeds(bytes32) view returns (address currency0, address currency1, uint32 lastTime, int24 lastTick, int56 tickCumulative, uint16 latestIndex, uint16 count)",
  "event FeedAdded(bytes32 indexed id, address currency0, address currency1, int24 tick)",
  ...ERRORS,
];

export const FEE_INBOX = ["function forward(address token) returns (uint256)", "function target() view returns (address)", ...ERRORS];
export const FEE_SPLITTER = ["function distribute(address token) returns (uint256, uint256)", ...ERRORS];
export const ALLOCATOR = ["function allocatePartial(address token, uint256 maxAmount) returns (uint256[3])", ...ERRORS];
export const CREATOR_PAYOUT = ["function payoutPartial(address token, uint256 maxAmount)", ...ERRORS];
export const YIELD_ROUTER = ["function routePartial(address token, uint256 maxAmount)", ...ERRORS];

export const RESERVE = [
  "function harvest(address asset) returns (uint256)",
  "function harvestAll() returns (uint256[3])",
  "function sweep(address token) returns (uint256)",
  "function assetCount() view returns (uint256)",
  "function assetAt(uint256) view returns (address)",
  "function isReserveAsset(address) view returns (bool)",
  "function principal(address) view returns (uint256)",
  "function valueOf(address) view returns (uint256)",
  "function pendingYield(address) view returns (uint256)",
  ...ERRORS,
];

export const BRIDGE_OUT = [
  "function bridge() returns (uint256)",
  "function minAmount() view returns (uint256)",
  "function token() view returns (address)",
  "event Bridged(uint256 amount, address indexed l1Recipient)",
  ...ERRORS,
];

export const STAKING = [
  "function poke()",
  "function queuedRewards() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  "function DURATION() view returns (uint256)",
];

export const ASCEND_ESCROW = [
  "function settle()",
  "function claim(address account)",
  "function claimable(address account) view returns (uint256)",
  "function held() view returns (uint256)",
  "function recipient() view returns (address)",
];

export const STAKE_AND_LOCK = ["function stake() returns (uint256)", "function asset() view returns (address)", ...ERRORS];

export const YIELD_UNSTAKE_BRIDGE = [
  "function requestUnstake() returns (uint256 requestId, uint256 assets)",
  "function confirm(uint256 requestId) returns (uint256)",
  "function bridge(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost) payable returns (uint256)",
  "function l2Recipient() view returns (address)",
  "function minGas() view returns (uint256)",
  "function minGasPrice() view returns (uint256)",
  "function asset() view returns (address)",
  "function vault() view returns (address)",
  "event Bridged(uint256 amount, address indexed l2Recipient)",
  ...ERRORS,
];

export const SKNTQ = [
  "function withdrawalDelay() view returns (uint256)",
  "function nextWithdrawalRequestId(address) view returns (uint256)",
  "function withdrawalRequest(address owner, uint256 id) view returns (uint256 assets, uint256 shares, uint256 timestamp)",
  "function balanceOf(address) view returns (uint256)",
];

export const INBOX = ["function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)"];

export const VAULT = [
  "function harvest()",
  "function rebalance(int24 expectedTick, int24 maxDrift)",
  "function keeper() view returns (address)",
  "function price() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function main() view returns (int24 lower, int24 upper, uint128 liquidity)",
  "function pendingFees() view returns (uint256 fee0, uint256 fee1)",
  "function lastHarvest() view returns (uint256)",
  "function lastRebalance() view returns (uint256)",
  "function REBALANCE_COOLDOWN() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "error NotKeeper()",
  "error PriceMoved(int24 tick, int24 expectedTick)",
  "error TooSoon(uint256 availableAt)",
  ...ERRORS,
];
