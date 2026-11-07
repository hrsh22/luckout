# Use three fair Game Versions with one margin

Every Lucky Buy, whatever its size and whichever Game Version the customer picks, has the same expected Final Price of exactly 106% of its Lucky Amount: a 6% Target Gross Margin. Everyone gets the same odds, every Draw is independent, and there are no loyalty odds, pity timers, or streak bonuses, so splitting one large purchase into many small ones, or merging small ones, cannot change the expected price. The Game Versions differ only in how much extra the customer risks and how big the wins are:

| Final Price | Classic (+10%) | Bold (+25%) | Jackpot (+50%) |
| ----------: | -------------: | ----------: | -------------: |
|          0% |              — |          2% |            10% |
|         50% |             1% |          6% |            15% |
|         80% |             3% |         10% |              — |
|        100% |            25% |         30% |            28% |
|  max price  |            71% |         52% |            47% |

| | Classic | Bold | Jackpot |
| --- | ---: | ---: | ---: |
| Pays less than Reference Price | 4% | 18% | 25% |
| Pays Reference Price or less | 29% | 48% | 53% |
| Largest Refund, as a share of the Lucky Amount | 60% | 125% | 150% |
| Largest Reference Discount, as a share of the Lucky Amount | 50% | 100% | 100% |

The customer chooses between Normal (a Standard Purchase at Reference Price with no Draw) and the three Game Versions. They set a Default Mode once and every purchase uses it unless they pick another mode for that purchase, so buying needs no mode prompt.

There is no limit on purchase size. Instead, the Discount Cap limits the largest Reference Discount any one Lucky Buy can produce to 20% of Free Reserve at admission. When a Game Version's largest discount on the full Reference Price would exceed the cap, the Game Version applies only to the Lucky Amount: the largest part of the Reference Price whose largest discount fits within the cap. The rest of the Voucher is bought at Reference Price. The Risk Premium is charged only on the Lucky Amount, so the expected Final Price stays exactly 6% of the Lucky Amount above Reference Price and the margin never grows with purchase size. Capping the Refund while still charging the premium on the full price was rejected: it would raise the expected extra cost of a 1,000 USDC Jackpot purchase from 6% to 22.5%. For example, with 200 USDC of Free Reserve the cap is 40 USDC, so a 1,000 USDC Jackpot purchase has a 40 USDC Lucky Amount and a final price between 960 and 1,020 USDC. Small purchases are unaffected: about 30 USDC of Free Reserve lets every Game Version apply in full to a ₹500 voucher. The Web App and the Agent show the Lucky Amount whenever it is smaller than the purchase, and the cap grows as the reserve grows. Because the Draw runs as soon as delivery is confirmed, reserve locks last only seconds.

At admission the contract debits the Maximum Price from the customer's Balance and locks the Lucky Buy's largest possible Reference Discount from Free Reserve. At settlement the customer's Balance receives the Refund, the operator receives the Reference Price, and the Free Reserve changes by `Risk Premium − Refund`. Outcome tables are immutable basis-point tables; the contract validates at registration that each sums to 10,000 basis points, never exceeds the Maximum Price, includes at least one discount, and averages exactly 106%.
