// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A stand-in for HyperCore in tests: one perp, USDC, and the behaviour the hedged vault
/// depends on. Actions are only recorded when they are sent and are carried out by `step()`, which a
/// test calls where a block ends; a rejected action leaves no trace on the EVM side, as on the real
/// thing. Fills happen at the oracle price, the taker fee is 0.045%, opening needs 10% margin, and a
/// position under 5% margin is closed by the exchange.
///
/// It is a model of what Hyperliquid's documentation says, not of Hyperliquid. The points the
/// documentation leaves open are switches here, so the vault can be tested both ways.
contract CoreSim {
    struct Account {
        int256 rawUsd; // perp cash, 6 decimals; account value = rawUsd + szi * px
        int256 szi; // size units, negative is short
        uint256 spot8; // spot USDC, 8 decimals
    }

    struct Action {
        address who;
        bytes data;
    }

    struct Transfer {
        address who;
        uint256 amount;
        uint32 dex;
    }

    address internal constant USDC_TO_EVM = 0x2000000000000000000000000000000000000000;
    uint32 internal constant SPOT_DEX = type(uint32).max;

    IERC20 public immutable usdc;
    uint32 public immutable perp;
    uint8 public immutable szDecimals;
    address public writer;
    address public wallet;

    uint256 public px; // raw oracle price
    mapping(address => Account) public accounts;
    /// @dev An account has paid the one-time charge once it has sent something out.
    mapping(address => bool) public activated;
    /// @dev What HyperCore takes for a send out, in USDC with 8 decimals, as seen on mainnet on
    /// 2026-11-26: 1 USDC the first time, and 0.001222 USDC every time for an account without HYPE.
    uint256 public constant FIRST_SEND_CHARGE = 100_000_000;
    uint256 public constant SEND_CHARGE = 122_200;
    Action[] internal _actions;
    Transfer[] internal _deposits;

    // switches
    bool public rejectOrders;
    bool public rejectTransfers;
    uint256 public fillBps = 10_000; // share of each order that fills
    bool public minOrderOnClose; // does the $10 minimum also apply to an order that closes the position?

    // what happened, for assertions
    uint256 public ordersFilled;
    uint256 public ordersRejected;
    uint256 public transfersRejected;
    uint256 public liquidations;
    uint256 public feesPaid;

    constructor(IERC20 usdc_, uint32 perp_, uint8 szDecimals_, uint256 px_) {
        (usdc, perp, szDecimals, px) = (usdc_, perp_, szDecimals_, px_);
    }

    function wire(address writer_, address wallet_) external {
        require(writer == address(0), "wired");
        (writer, wallet) = (writer_, wallet_);
    }

    // ------------------------------------------------------------------ test controls

    function setPx(uint256 px_) external {
        px = px_;
    }

    function setRejectOrders(bool on) external {
        rejectOrders = on;
    }

    function setRejectTransfers(bool on) external {
        rejectTransfers = on;
    }

    function setFillBps(uint256 bps) external {
        fillBps = bps;
    }

    function setMinOrderOnClose(bool on) external {
        minOrderOnClose = on;
    }

    /// @notice Funding: a short receives `rate1e8` of its size's value (pays when negative).
    function payFunding(address who, int256 rate1e8) external {
        Account storage a = accounts[who];
        a.rawUsd += -a.szi * int256(px) * rate1e8 / 1e8;
    }

    // ------------------------------------------------------------------ what the precompiles serve

    function accountValue(address who) public view returns (int256) {
        Account storage a = accounts[who];
        return a.rawUsd + a.szi * int256(px);
    }

    function notional(address who) public view returns (uint256) {
        int256 s = accounts[who].szi;
        return uint256(s < 0 ? -s : s) * px;
    }

    function pending() external view returns (uint256 actions, uint256 deposits) {
        return (_actions.length, _deposits.length);
    }

    // ------------------------------------------------------------------ the EVM side sends

    function enqueue(address who, bytes calldata data) external {
        require(msg.sender == writer, "writer only");
        _actions.push(Action(who, data));
    }

    function depositFrom(address who, uint256 amount, uint32 dex) external {
        require(msg.sender == wallet, "wallet only");
        _deposits.push(Transfer(who, amount, dex));
    }

    // ------------------------------------------------------------------ the block ends

    /// @notice Carries out what the block sent: deposits first, then actions in the order sent, then
    /// the exchange checks every account that acted for liquidation.
    function step() external {
        for (uint256 i; i < _deposits.length; i++) {
            Transfer memory d = _deposits[i];
            if (d.dex == 0) accounts[d.who].rawUsd += int256(d.amount);
            else accounts[d.who].spot8 += d.amount * 100;
        }
        delete _deposits;
        for (uint256 i; i < _actions.length; i++) {
            Action memory a = _actions[i];
            _act(a.who, a.data);
        }
        delete _actions;
    }

    /// @notice The exchange closes a position whose margin is under 5%. Under two thirds of that its
    /// backstop takes the position and what margin is left.
    function liquidateIfDue(address who) public returns (bool) {
        Account storage a = accounts[who];
        if (a.szi == 0) return false;
        int256 value = accountValue(who);
        uint256 ntl = notional(who);
        if (value * 20 >= int256(ntl)) return false;
        bool backstop = value * 30 < int256(ntl);
        a.rawUsd = backstop ? int256(0) : value;
        a.szi = 0;
        liquidations++;
        return true;
    }

    function _act(address who, bytes memory data) private {
        require(uint8(data[0]) == 1, "version");
        uint24 id = (uint24(uint8(data[1])) << 16) | (uint24(uint8(data[2])) << 8) | uint24(uint8(data[3]));
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; i++) {
            body[i] = data[i + 4];
        }
        if (id == 1) _order(who, body);
        else if (id == 7) _classTransfer(who, body);
        else if (id == 13) _sendAsset(who, body);
        else revert("unknown action");
    }

    struct Order {
        uint32 asset;
        bool isBuy;
        uint256 limitRaw;
        uint256 sz;
        bool reduceOnly;
        uint8 tif;
    }

    function _order(address who, bytes memory body) private {
        Order memory o;
        {
            (uint32 asset, bool isBuy, uint64 limitPx, uint64 sz8, bool reduceOnly, uint8 tif,) =
                abi.decode(body, (uint32, bool, uint64, uint64, bool, uint8, uint128));
            o = Order(
                asset,
                isBuy,
                uint256(limitPx) / 10 ** (2 + szDecimals),
                uint256(sz8) / 10 ** (8 - szDecimals) * fillBps / 10_000,
                reduceOnly,
                tif
            );
        }
        if (!_accept(who, o) || !_fill(who, o)) ordersRejected++;
        else ordersFilled++;
    }

    /// @dev Whether the exchange takes the order at all; trims a reduce-only order to the open position.
    function _accept(address who, Order memory o) private view returns (bool) {
        if (rejectOrders || o.asset != perp || o.tif != 3 || o.sz == 0) return false;
        if (o.isBuy ? o.limitRaw < px : o.limitRaw > px) return false; // does not cross: cancelled
        if (o.limitRaw >= 100_000) {
            // five significant figures at most
            uint256 unit = 1;
            while (o.limitRaw / unit >= 100_000) unit *= 10;
            if (o.limitRaw % unit != 0) return false;
        }
        bool closes;
        if (o.reduceOnly) {
            int256 szi = accounts[who].szi;
            uint256 open = o.isBuy ? (szi < 0 ? uint256(-szi) : 0) : (szi > 0 ? uint256(szi) : 0);
            if (open == 0) return false;
            if (o.sz >= open) (o.sz, closes) = (open, true);
        }
        return o.sz * px >= 10e6 || (closes && !minOrderOnClose);
    }

    function _fill(address who, Order memory o) private returns (bool) {
        Account storage a = accounts[who];
        uint256 value = o.sz * px;
        uint256 fee = value * 45 / 100_000;
        (int256 rawBefore, int256 sziBefore) = (a.rawUsd, a.szi);
        a.szi += o.isBuy ? int256(o.sz) : -int256(o.sz);
        a.rawUsd += (o.isBuy ? -int256(value) : int256(value)) - int256(fee);
        // opening or enlarging needs 10% margin
        if (!o.reduceOnly && accountValue(who) * 10 < int256(notional(who))) {
            (a.rawUsd, a.szi) = (rawBefore, sziBefore);
            return false;
        }
        feesPaid += fee;
        return true;
    }

    function _classTransfer(address who, bytes memory body) private {
        (uint64 amount, bool toPerp) = abi.decode(body, (uint64, bool));
        Account storage a = accounts[who];
        if (rejectTransfers) {
            transfersRejected++;
        } else if (toPerp) {
            if (a.spot8 < uint256(amount) * 100) {
                transfersRejected++;
                return;
            }
            a.spot8 -= uint256(amount) * 100;
            a.rawUsd += int256(uint256(amount));
        } else {
            // what may leave the perp side: the account value above 10% of the position
            int256 free = accountValue(who) - int256(notional(who) / 10);
            if (free < int256(uint256(amount))) {
                transfersRejected++;
                return;
            }
            a.rawUsd -= int256(uint256(amount));
            a.spot8 += uint256(amount) * 100;
        }
    }

    function _sendAsset(address who, bytes memory body) private {
        (address to,, uint32 srcDex, uint32 dstDex, uint64 token, uint64 amount8) =
            abi.decode(body, (address, address, uint32, uint32, uint64, uint64));
        Account storage a = accounts[who];
        // the charge comes out of what stays behind; a send that does not leave it is refused
        uint256 charge = SEND_CHARGE + (activated[who] ? 0 : FIRST_SEND_CHARGE);
        if (
            rejectTransfers || to != USDC_TO_EVM || srcDex != SPOT_DEX || dstDex != SPOT_DEX || token != 0
                || a.spot8 < amount8 + charge
        ) {
            transfersRejected++;
            return;
        }
        a.spot8 -= amount8 + charge;
        activated[who] = true;
        usdc.transfer(who, uint256(amount8) / 100);
    }
}

/// @notice The read-only system addresses. One piece of code, placed at each address with `vm.etch`;
/// it answers by the address it finds itself at.
contract CorePrecompile {
    CoreSim internal immutable sim;

    constructor(CoreSim sim_) {
        sim = sim_;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        uint160 self = uint160(address(this));
        if (self == 0x0807 || self == 0x0806) return abi.encode(uint64(sim.px()));
        if (self == 0x0800) {
            (address who,) = abi.decode(data, (address, uint16));
            (, int256 szi,) = sim.accounts(who);
            return abi.encode(int64(szi), uint64(0), int64(0), uint32(10), false);
        }
        if (self == 0x0801) {
            (address who, uint64 token) = abi.decode(data, (address, uint64));
            (,, uint256 spot8) = sim.accounts(who);
            return abi.encode(uint64(token == 0 ? spot8 : 0), uint64(0), uint64(0));
        }
        if (self == 0x080F) {
            (, address who) = abi.decode(data, (uint32, address));
            (int256 raw,,) = sim.accounts(who);
            uint256 ntl = sim.notional(who);
            return abi.encode(int64(sim.accountValue(who)), uint64(ntl / 10), uint64(ntl), int64(raw));
        }
        revert("no such precompile");
    }
}

/// @notice Placed at CoreWriter's address with `vm.etch`.
contract CoreWriterMock {
    CoreSim internal immutable sim;

    constructor(CoreSim sim_) {
        sim = sim_;
    }

    function sendRawAction(bytes calldata data) external {
        sim.enqueue(msg.sender, data);
    }
}

/// @notice Stands in for Circle's CoreDepositWallet.
contract CoreDepositWalletMock {
    CoreSim internal immutable sim;
    IERC20 internal immutable usdc;

    constructor(CoreSim sim_, IERC20 usdc_) {
        (sim, usdc) = (sim_, usdc_);
    }

    function deposit(uint256 amount, uint32 destinationDex) external {
        usdc.transferFrom(msg.sender, address(sim), amount);
        sim.depositFrom(msg.sender, amount, destinationDex);
    }
}
