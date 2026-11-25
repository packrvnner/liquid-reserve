#!/usr/bin/env python3
"""The site's settings for the NVDAx-USDC vault, kept out of site/deployment.json until the vault is launched.

site/deployment.json is published with the site and shared by every session working in this folder, so the new
vault's entries are added to it only at publish time. Until then they live here, and the site's scripts do nothing
with a vault they are not told about.

  python3 script/nvda-site-config.py --fork [port]   writes site/deployment.nvda-fork.json: the live settings plus
                                                     the vault, reading Elysium from a local fork (default 8611).
                                                     Open  http://localhost:4174/?deployment=deployment.nvda-fork.json&devwallet=1
  python3 script/nvda-site-config.py --apply         adds the entries to site/deployment.json (read, change, write:
                                                     everything else in the file is kept). Run it when the vault is
                                                     live and the site is about to be published. Add --verified once
                                                     the vault is an exact match on Sourcify.
  python3 script/nvda-site-config.py --check         says whether site/deployment.json has the entries, changes nothing

Addresses come from site/tools/nvda-vault-data.json (script/nvda-vault-data.py).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
D = json.load(open(os.path.join(SITE, "tools", "nvda-vault-data.json")))
E, HL = D["elysium"], D["hyperliquid"]

NOTE = ("wNVDAx is the wrapped NVIDIA xStock, a tokenised stock, carried to Elysium from HyperEVM over the bridge. Its issuer "
        "says xStocks are not available in the United States or to U.S. persons, are not currently available in the United "
        "Kingdom, and that other country limits apply. Liquid Reserve has no tie to NVIDIA or to the issuer. This vault is "
        "the only liquidity in its pool (wNVDAx also trades in other pools on Elysium, which this vault does not use), so "
        "the pool's price follows the market only when someone trades against the vault, and after a large move the vault "
        "can sit in one token until trades come back.")


def vault_entry(verified):
    v = {
        "id": "nvda-usdc", "name": "NVDAx-USDC", "token0": "wNVDAx", "token1": "USDC", "feeTier": "0.30%", "fee": E["key"]["fee"],
        "pool": E["pool"], "address": E["vault"], "feeTo": D["feeTo"], "priceSetter": E["priceSetter"],
        "alone": True, "note": NOTE,
    }
    if verified:
        v["verified"] = True
    return v


def merged(cfg, verified):
    """cfg with the vault's entries added (or refreshed). Nothing else is touched."""
    cfg["tokens"]["wNVDAx"] = {"address": E["wnvdax"], "decimals": 18}
    cfg["pools"]["wnvdaxUsdc"] = E["pool"]
    hl = cfg.setdefault("hyperliquid", {"api": HL["api"]})
    hl.setdefault("coins", {})["wNVDAx"] = HL["coin"]
    hl.setdefault("spot", {})["wNVDAx"] = {"index": HL["index"], "szDecimals": HL["szDecimals"]}
    entry, vaults = vault_entry(verified), cfg["vaults"]
    at = next((i for i, v in enumerate(vaults) if v["id"] == entry["id"]), None)
    if at is not None:
        entry = {**vaults[at], **entry} if not verified and vaults[at].get("verified") else entry
        vaults[at] = entry
    else:
        # straight after the ANTx-USDC vault, before the retired ones
        after = next((i for i, v in enumerate(vaults) if v["id"] == "antx-usdc"), len(vaults) - 1)
        vaults.insert(after + 1, entry)
    return cfg


def has_entries(cfg):
    return ("wNVDAx" in cfg.get("tokens", {}) and cfg.get("pools", {}).get("wnvdaxUsdc") == E["pool"]
            and cfg.get("hyperliquid", {}).get("coins", {}).get("wNVDAx") == HL["coin"]
            and any(v["id"] == "nvda-usdc" and v["address"] == E["vault"] for v in cfg.get("vaults", [])))


def in_text(text, verified):
    """The same change made in the file's own text, so its hand-kept layout survives. None when the text is not
    laid out the way this expects (the caller then checks the result and falls back to a plain rewrite)."""
    cfg = json.loads(text)
    if any(v["id"] == "nvda-usdc" for v in cfg.get("vaults", [])):
        if not verified or next(v for v in cfg["vaults"] if v["id"] == "nvda-usdc").get("verified"):
            return text
        at = text.find('"id": "nvda-usdc"')
        end = text.find("\n    }", at)
        return None if at < 0 or end < 0 else text[:end] + ',\n      "verified": true' + text[end:]

    def after_line(t, marker, extra):
        """Adds `extra` as new lines after the one line that contains `marker`, giving that line its comma."""
        lines = t.split("\n")
        hits = [i for i, l in enumerate(lines) if marker in l]
        if len(hits) != 1:
            return None
        i = hits[0]
        if not lines[i].rstrip().endswith(","):
            lines[i] = lines[i].rstrip() + ","
        return "\n".join(lines[: i + 1] + extra + lines[i + 1:])

    t = after_line(text, '"wANTx": "@', [f'      "wNVDAx": "{HL["coin"]}"'])
    t = t and after_line(t, '"wANTx": { "index"', [f'      "wNVDAx": {{ "index": {HL["index"]}, "szDecimals": {HL["szDecimals"]} }}'])
    t = t and after_line(t, '"wantxUsdc": "', [f'    "wnvdaxUsdc": "{E["pool"]}"'])
    if not t:
        return None
    # tokens: after the wANTx entry, the last in the list
    old = '    "wANTx": {\n      "address": "%s",\n      "decimals": 18\n    }\n  },' % cfg["tokens"]["wANTx"]["address"]
    if t.count(old) != 1:
        return None
    t = t.replace(old, old[:-5] + ',\n    "wNVDAx": {\n      "address": "%s",\n      "decimals": 18\n    }\n  },' % E["wnvdax"])
    # vaults: after the ANTx-USDC vault's entry
    at = t.find('"id": "antx-usdc"')
    end = t.find("\n    },\n", at)
    if at < 0 or end < 0:
        return None
    body = json.dumps(vault_entry(verified), indent=2, ensure_ascii=False).replace("\n", "\n    ")
    return t[: end + 8] + "    " + body + ",\n" + t[end + 8:]


live_path = os.path.join(SITE, "deployment.json")
if "--fork" in sys.argv:
    i = sys.argv.index("--fork")
    port = sys.argv[i + 1] if len(sys.argv) > i + 1 and sys.argv[i + 1].isdigit() else "8611"
    cfg = merged(json.load(open(live_path)), "--verified" in sys.argv)
    cfg["label"] = f"Elysium fork on port {port} (NVDAx-USDC vault rehearsal)"
    cfg["elysium"]["rpc"] = f"http://127.0.0.1:{port}"
    out = os.path.join(SITE, "deployment.nvda-fork.json")
    json.dump(cfg, open(out, "w"), indent=1)
    print("wrote", os.path.relpath(out, ROOT))
elif "--apply" in sys.argv:
    verified = "--verified" in sys.argv
    text = open(live_path).read()                      # read again right here: other sessions edit this file
    want = merged(json.loads(text), verified)
    new = in_text(text, verified)
    if new is None or json.loads(new) != want:
        # the file is not laid out as expected: write the same settings in plain two-space layout instead
        new = json.dumps(want, indent=2, ensure_ascii=False) + "\n"
        print("note: the file's layout was not as expected, so it was rewritten in plain two-space layout (same settings)")
    assert json.loads(new) == want and has_entries(json.loads(new))
    open(live_path, "w").write(new)
    print("site/deployment.json now lists the NVDAx-USDC vault" + (" (verified)" if verified else ""))
else:
    print("site/deployment.json", "HAS" if has_entries(json.load(open(live_path))) else "does NOT have", "the NVDAx-USDC vault's entries")
