use anchor_lang::prelude::*;

#[error_code]
pub enum LuckoutError {
    #[msg("Only the owner")]
    NotOwner,
    #[msg("Only the operator")]
    NotOperator,
    #[msg("Not the proposed owner")]
    NotProposedOwner,
    #[msg("That key can't take this role")]
    BadRole,
    #[msg("This account was written by a newer build")]
    NewerLayout,
    #[msg("New purchases are paused")]
    Paused,
    #[msg("A Checkout holds 1 to 15 cards")]
    BadCart,
    #[msg("Not the customer's next Checkout number")]
    WrongCheckoutNumber,
    #[msg("Purchases start at 0.5 USDC")]
    BelowMinimumPrice,
    #[msg("A Normal purchase has no Lucky Amount")]
    NormalHasLuckyAmount,
    #[msg("Invalid Lucky Amount")]
    InvalidLuckyAmount,
    #[msg("The Cashback Reserve moved since you confirmed; please confirm again")]
    ReserveMoved,
    #[msg("Reserve too small for a Lucky Buy; use Normal")]
    ReserveTooSmall,
    #[msg("Price changed since you confirmed; please confirm again")]
    PriceChanged,
    #[msg("Over the per-purchase spending limit")]
    OverPerPurchaseLimit,
    #[msg("Over the daily spending limit")]
    OverDailyLimit,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("A Lucky Checkout plays at least the smallest Lucky Checkout")]
    LuckyCheckoutTooSmall,
    #[msg("Unknown game version")]
    UnknownGameVersion,
    #[msg("Invalid game version")]
    BadGameVersion,
    #[msg("No such card in this Checkout")]
    UnknownCard,
    #[msg("A card is named twice")]
    DuplicateCard,
    #[msg("Purchase is already closed")]
    NotPending,
    #[msg("Reclaim opens 24 hours after purchase")]
    TooEarlyToReclaim,
    #[msg("Deposit at least 1 USDC")]
    DepositTooSmall,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Exceeds free reserve")]
    ExceedsFreeReserve,
    #[msg("Exceeds proceeds")]
    ExceedsProceeds,
    #[msg("The randomness accounts are missing")]
    MissingRandomnessAccounts,
    #[msg("Not this Checkout's randomness account")]
    WrongRandomnessAccount,
    #[msg("The randomness hasn't arrived yet")]
    RandomnessNotFilled,
    #[msg("The randomness has arrived: finish the Draw instead")]
    RandomnessFilled,
    #[msg("No card is waiting on this request")]
    NothingToDraw,
    #[msg("A request can be replaced an hour after it was made")]
    TooEarlyToRequestAgain,
    #[msg("Too many randomness requests for one Checkout")]
    TooManyRounds,
    #[msg("Wrong token account")]
    WrongTokenAccount,
    #[msg("The fixed limit must be above 0, and the reserve share above 0% and at most 50%")]
    BadCashbackCap,
    #[msg("Too many game versions")]
    TooManyVersions,
    #[msg("A mainnet build takes only Circle's USDC")]
    NotUsdc,
}
