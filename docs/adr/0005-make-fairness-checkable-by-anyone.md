# Make fairness checkable by anyone

Customers are asked to pay a premium for a chance, so "trust us" is not enough. Every Draw has a public Draw Proof: the Web App links each result to its NEAR transaction and recomputes the Cashback in the browser from the seed, the purchase ID, and the immutable Game Version table, without asking our server. A public page shows the Live Average beside the promised 105.6%. Each customer sees their Running Total, so they always know whether they are ahead or behind overall; together with Spending Limits this is our responsible-play control. A Lucky Buy that ends below Reference Price offers a Win Card for sharing, which links to its Draw Proof and never contains Redemption Data.

All of this is read from contract state and events, so the contract emits, for every settled Draw, the purchase ID, customer, Game Version, Reference Price, Lucky Amount, Maximum Price, seed, random value, roll, Final Price, and Cashback. No streaks, loyalty odds, or near-miss presentation are added, because they would contradict ADR-0002's equal-odds promise.

Deferred until after the first working build: a demo of the Agent being instructed to overspend and the contract refusing, shared group balances for Telegram groups, onboarding through a Telegram Mini App, and Autopilot.
