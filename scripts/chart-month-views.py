#!/usr/bin/env python3
"""Month-end mix charts from views/series.json."""
import json
from pathlib import Path

import matplotlib.pyplot as plt

ROOT = Path.home() / "robotdojo/user/files/family/finances/monarch/views"
OUT = ROOT / "charts"
OUT.mkdir(parents=True, exist_ok=True)
series = json.loads((ROOT / "series.json").read_text())
months = [r["month"] for r in series]

def col(bucket):
    return [((r.get("mix") or {}).get(bucket) or {}).get("total") or 0 for r in series]

def pct(bucket):
    return [((r.get("mixPct") or {}).get(bucket) or {}).get("total") or 0 for r in series]

def save(name):
    plt.tight_layout()
    plt.savefig(OUT / name, dpi=140)
    plt.close()

# dollars
plt.figure(figsize=(11, 5.5))
plt.stackplot(
    months,
    col("Equities"), col("Crypto"), col("Gold"), col("Silver"), col("Cash"),
    labels=["Equities", "Crypto", "Gold", "Silver", "Cash"],
    alpha=0.9,
)
plt.xticks(rotation=60, ha="right")
plt.ylabel("$")
plt.title("Month-end mix")
plt.legend(loc="upper left")
save("mix-dollars.png")

# pct
plt.figure(figsize=(11, 5.5))
plt.stackplot(
    months,
    pct("Equities"), pct("Crypto"), pct("Gold"), pct("Silver"), pct("Cash"),
    labels=["Equities", "Crypto", "Gold", "Silver", "Cash"],
    alpha=0.9,
)
plt.xticks(rotation=60, ha="right")
plt.ylabel("% of book")
plt.ylim(0, 100)
plt.title("Month-end mix %")
plt.legend(loc="upper left")
save("mix-pct.png")

# btc vs gold
btc = [((r.get("crypto") or {}).get("BTC + MSTR") or {}).get("total") or 0 for r in series]
gold = [((r.get("reserve") or {}).get("Gold") or {}).get("total") or 0 for r in series]
plt.figure(figsize=(11, 5))
plt.plot(months, btc, label="BTC + MSTR")
plt.plot(months, gold, label="Gold")
plt.xticks(rotation=60, ha="right")
plt.ylabel("$")
plt.title("BTC + MSTR vs gold")
plt.legend()
save("btc-vs-gold.png")

# QC: mix vs monarch book (should overlay) and brokerage
mix = [r.get("mixTotal") or 0 for r in series]
book = [r.get("monarchBook") or 0 for r in series]
brok = [r.get("monarchBrokerage") or 0 for r in series]
plt.figure(figsize=(11, 5.5))
plt.plot(months, mix, label="Mix (accounts + lots)")
plt.plot(months, book, label="Monarch book", linestyle="--")
plt.plot(months, brok, label="Monarch brokerage", alpha=0.7)
plt.xticks(rotation=60, ha="right")
plt.ylabel("$")
plt.title("QC vs Monarch")
plt.legend()
save("qc-vs-monarch.png")
print("wrote", OUT)
