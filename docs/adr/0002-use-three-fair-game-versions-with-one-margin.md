# Use three fair Game Versions with one margin

Every Lucky Buy, whatever its size and whichever Game Version the customer picks, has the same expected Final Price of exactly 105.6% of its Lucky Amount: a 5.6% Target Gross Margin. Everyone gets the same odds, every Draw is independent, and there are no loyalty odds, pity timers, or streak bonuses, so splitting one large purchase into many small ones, or merging small ones, cannot change the expected price.

A Lucky Buy debits its Maximum Price up front, and the Draw pays Cashback as a share of what the customer paid, in 10% slabs. Small Cashback is common and big Cashback is rare. Every slab leaves the customer below the Reference Price, so Cashback always means they paid less than a Standard Purchase would cost; no table may pay Cashback that still leaves the price above normal. The Game Versions differ only in how much extra is paid up front and in how often and how big the Cashback is:

| Cashback, as a share of what was paid | Lite (+10%) | Classic (+20%) | Jackpot (+50%) |
| --- | ---: | ---: | ---: |
| 100% (free) | 1% | 2% | 10% |
| 50% | 1% | 3% | 12% |
| 40% | — | 4% | 34% |
| 30% | 1% | 7% | — |
| 20% | 2% | 24% | — |
| 10% | 18% | — | — |
| None | 77% | 60% | 44% |
| **Any Cashback** | **23%** | **40%** | **56%** |

On a ₹500 voucher, Classic costs ₹600 up front, and 20% back means paying ₹480. Each version's smallest slab is the smallest that still leaves the customer below the Reference Price: 10% for Lite, 20% for Classic, 40% for Jackpot. The contract stores each table as Final Price shares of the Lucky Amount; Classic is 0, 6,000, 7,200, 8,400, 9,600 and 12,000 basis points.

These numbers were chosen for a customer who buys every weekday, so the month matters more than one Draw. The margin is 5.6% rather than 6% because 5.6% is the only margin at or below 6% that every table can hit exactly with whole-percent odds at +10%, +20% and +50%. Frequent small Cashback with rare free vouchers was chosen over a free-heavy table (such as Classic with 10% free) for day-to-day satisfaction, accepting fewer free vouchers a month. A continuous curve of Cashback was rejected: it can't be published as a table of exact odds, and it gives a free voucher no chance at all. Lucky modes priced at +10% feel like a fee to daily buyers (fewer than 1 month in 20 ends ahead), which is why Classic, the mode the pitch leads with, is +20%.

The customer chooses between Normal (a Standard Purchase at Reference Price with no Draw) and the three Game Versions. They set a Default Mode once and every purchase uses it unless they pick another mode for that purchase, so buying needs no mode prompt.

There is no limit on purchase size. Instead two caps bound what one Lucky Buy can produce: the Cashback Cap of 50 USDC, and the Discount Cap, which limits the largest Reference Discount to 20% of Free Reserve at admission. When a Game Version's largest Cashback or largest discount on the full Reference Price would exceed either cap, the Game Version applies only to the Lucky Amount: the largest part of the Reference Price that fits both. The rest of the Voucher is bought at Reference Price. The Risk Premium is charged only on the Lucky Amount, so the expected Final Price stays exactly 5.6% of the Lucky Amount above Reference Price and the margin never grows with purchase size. Capping the Cashback while still charging the premium on the full price was rejected: it would make big purchases much worse than small ones. For example, with 1,000 USDC of Free Reserve the Cashback Cap binds first, so a 1,000 USDC Classic purchase has a 41.67 USDC Lucky Amount, costs 1,008.33 USDC up front, and its free result returns 50 USDC. Small purchases are unaffected: about 30 USDC of Free Reserve lets every Game Version apply in full to a ₹500 voucher. The Web App and the Agent show the Lucky Amount whenever it is smaller than the purchase. Because the Draw runs as soon as delivery is confirmed, reserve locks last only seconds.

The Cashback Cap is sized for an initial reserve of 1,000 USDC. Simulating 3,000 Lucky Buys that all play the maximum Lucky Amount, the reserve's deepest dip was 116 USDC on Lite, 165 on Classic and 560 on Jackpot (the 1-in-100 dip on Jackpot was 325), while the margin added several thousand USDC. It is a contract constant, raised with a redeploy as the reserve grows.

At admission the contract debits the Maximum Price from the customer's Balance and locks the Lucky Buy's largest possible Reference Discount from Free Reserve. At settlement the customer's Balance receives the Cashback, the operator receives the Reference Price, and the Free Reserve changes by `Risk Premium − Cashback`. Outcome tables are immutable basis-point tables; the contract validates at registration that each sums to 10,000 basis points, never exceeds the Maximum Price, pays no Cashback that leaves the price at or above Reference Price, includes at least one discount, and averages exactly 105.6%.

**Amended 2026-11-09.** The original tables (Classic +10%, Bold +25%, Jackpot +50%, each averaging 106%) described outcomes as a Final Price, such as "best case ₹250" on a ₹550 Classic purchase, which even the team misread as ₹250 coming back. They were replaced by the Cashback tables above, the margin moved from 6% to 5.6% so every table is exact, and the Cashback Cap was added.
