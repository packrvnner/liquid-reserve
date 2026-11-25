#!/usr/bin/env python3
"""Check the source files in this repository against what Sourcify holds for every deployed contract.

For each entry of deployments/addresses.json this asks Sourcify (https://sourcify.dev) two things:
  1. is the contract at that address an exact match (the published source compiles to exactly the code on-chain)?
  2. which source files is that match made of?
and then compares every one of those files, byte for byte, with the file of the same path here (src/ and lib/).

It only reads: nothing is sent to a chain and no wallet is involved. Needs Python 3 and nothing else.
The lib/ folders must be present (git clone --recurse-submodules, or git submodule update --init --recursive).

    python3 script/check-sourcify.py                 # everything
    python3 script/check-sourcify.py 0x05D6A15d...   # only addresses starting with this

Exit code 0 when every contract is an exact match and every file is identical, 1 otherwise.
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://sourcify.dev/server/v2/contract/{chain}/{address}?fields=sources,compilation"


def fetch(chain, address):
    req = urllib.request.Request(API.format(chain=chain, address=address), headers={"User-Agent": "check-sourcify/1"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # network trouble or rate limit: wait and try again
            last = e
            time.sleep(2 + 2 * attempt)
    raise SystemExit(f"Sourcify could not be reached for {address}: {last}")


def main():
    only = [a.lower() for a in sys.argv[1:]]
    book = json.load(open(os.path.join(ROOT, "deployments", "addresses.json")))
    problems = 0
    files = 0
    for c in book["contracts"]:
        if only and not any(c["address"].lower().startswith(o) for o in only):
            continue
        got = fetch(c["chain"], c["address"])
        notes = []
        if got.get("match") != "exact_match":
            notes.append(f"Sourcify says: {got.get('match') or got.get('message') or 'not verified'}")
        name = (got.get("compilation") or {}).get("fullyQualifiedName", "")
        if name != f"{c['source']}:{c['contract']}":
            notes.append(f"Sourcify names it {name or 'nothing'}, the list says {c['source']}:{c['contract']}")
        sources = got.get("sources") or {}
        for path, entry in sources.items():
            files += 1
            local = os.path.join(ROOT, path)
            if not os.path.isfile(local):
                notes.append(f"missing here: {path}")
            elif open(local, "rb").read() != entry["content"].encode():
                notes.append(f"differs: {path}")
        problems += len(notes)
        chain = book["chains"][str(c["chain"])]["name"]
        print(f"{'ok  ' if not notes else 'FAIL'} {chain:8} {c['address']} {c['contract']:20} {len(sources):3} files  {c['label']}")
        for n in notes:
            print(f"       {n}")
        time.sleep(0.2)
    print(f"\n{files} source files compared, {problems} problem(s).")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
