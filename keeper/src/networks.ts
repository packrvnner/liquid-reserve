import { registerCustomArbitrumNetwork, ArbitrumNetwork } from "@arbitrum/sdk";

export const ELYSIUM_CHAIN_ID = 99901;
export const HYPEREVM_CHAIN_ID = 999;

/** Elysium (Kinetiq's Arbitrum Orbit chain) settling to HyperEVM. Addresses
 *  verified on-chain 2026-11-13 (Kinetiq "Contract addresses" page + rollup reads). */
export const ELYSIUM_NETWORK: ArbitrumNetwork = {
  name: "Elysium",
  chainId: ELYSIUM_CHAIN_ID,
  parentChainId: HYPEREVM_CHAIN_ID,
  confirmPeriodBlocks: 86_400, // HyperEVM blocks (~1 s each) => ~1 day (was 483,840, ~5.6 days, until mid Nov 2026)
  isCustom: true,
  isTestnet: false,
  isBold: true,
  ethBridge: {
    bridge: "0x503D572157113fAaaD4DbeD2647Bb10b949216B6",
    inbox: "0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff",
    sequencerInbox: "0x7f3Ff53aecB87261206ad3bDc27A88b6D8420fa6",
    outbox: "0xeC6B106DfA14428FE5Eec2a4065a7be599f02728",
    rollup: "0x508C173dFe5F737B3493195Bf785d71fA76fD217",
  },
  tokenBridge: {
    parentGatewayRouter: "0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0",
    childGatewayRouter: "0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17",
    parentErc20Gateway: "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c",
    childErc20Gateway: "0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f",
    parentCustomGateway: "0x0000000000000000000000000000000000000000",
    childCustomGateway: "0x0000000000000000000000000000000000000000",
    parentWethGateway: "0x4ADeEcE99eDfa453e40E79FfD2F179008F5a91EB",
    childWethGateway: "0xb916e67307ad52955d37B6C123CF1A79c10855B6",
    parentWeth: "0x5555555555555555555555555555555555555555",
    childWeth: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81",
    parentMultiCall: "0xcA11bde05977b3631167028862bE2a173976CA11",
    childMultiCall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },
};

let registered = false;
export function registerElysium(): ArbitrumNetwork {
  if (!registered) {
    registerCustomArbitrumNetwork(ELYSIUM_NETWORK, { throwIfAlreadyRegistered: false });
    registered = true;
  }
  return ELYSIUM_NETWORK;
}
