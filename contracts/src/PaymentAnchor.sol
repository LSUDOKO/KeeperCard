// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PaymentAnchor — on-chain receipts for KeeperCard payments
/// @notice Records that a KeeperCard card paid someone, as a public, append-only event
/// on the chain the payment settled on. KeeperCard's own charge ledger is a row in a
/// database; this is the same fact in a form anyone can read without asking KeeperCard.
///
/// WHO WRITES IT
///
/// KeeperHub does. After a payment confirms, KeeperCard asks KeeperHub to run the
/// `payment-receipt-anchor` workflow, which calls `anchorPayment` from KeeperHub's
/// wallet. Receipts are written in the background, downstream of the payment, so a slow
/// or failing receipt can never delay or fail the payment it describes.
///
/// WHAT A RECEIPT DOES AND DOES NOT ESTABLISH
///
/// Be precise about this, because the distinction is the whole trust model:
///
///   ESTABLISHED: that `anchoredBy` claimed, at this block, that this payment happened
///   with exactly these field values. The record is immutable and cannot be re-written:
///   a second anchor for the same `(sourceChainId, sourceTxHash)` reverts.
///
///   NOT established by this contract alone: that the payment it describes happened.
///   `sourceTxHash` is recorded so any verifier can open that transaction on the same
///   chain and check it against the receipt; `anchoredBy` records who made the claim.
///
/// Anchoring is permissionless on purpose — any address may anchor, and the anchorer
/// is recorded in the event. Consumers decide which anchorers they trust rather than
/// this contract maintaining a privileged writer set.
contract PaymentAnchor {
    /// @notice A card payment, anchored as a public receipt.
    /// @param cardId KeeperCard card id, as `keccak256(bytes(card.id))`.
    /// @param payer Account the USDC actually left on the source chain (the card
    /// tree's root delegator — the card's funding account).
    /// @param merchant Recipient of the payment.
    /// @param amount Amount in USDC atoms (6 decimals).
    /// @param sourceChainId EVM chain id where the USDC moved (8453 Base, 84532 Base Sepolia).
    /// @param sourceTxHash Transaction hash of the payment on `sourceChainId`.
    /// @param paidAt Unix seconds at which the payment confirmed on the source chain.
    /// @param anchoredBy Whoever submitted this anchor (`msg.sender`).
    /// @param memo Free-text note carried from the card's charge record.
    event PaymentAnchored(
        bytes32 indexed cardId,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 paidAt,
        address anchoredBy,
        string memo
    );

    /// @notice Number of anchors written, per card. Convenience for source-chain
    /// readers; the events themselves are the authoritative record.
    mapping(bytes32 => uint256) public anchorCount;

    /// @notice Guards against the same source payment being anchored twice, which
    /// would otherwise let one payment show up as several receipts by repetition.
    /// Keyed by `keccak256(sourceChainId, sourceTxHash)` so the same hash on two
    /// different chains stays distinct.
    mapping(bytes32 => bool) public anchored;

    error AlreadyAnchored(uint256 sourceChainId, bytes32 sourceTxHash);
    error ZeroAmount();
    error ZeroSourceTxHash();

    /// @notice Anchors one source-chain payment.
    /// @dev Rejects zero amounts and zero tx hashes: both are signs of a caller
    /// writing a placeholder, and an anchor nobody can check back against its source
    /// transaction is worse than no anchor.
    function anchorPayment(
        bytes32 cardId,
        address payer,
        address merchant,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 paidAt,
        string calldata memo
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (sourceTxHash == bytes32(0)) revert ZeroSourceTxHash();

        bytes32 key = sourceKey(sourceChainId, sourceTxHash);
        if (anchored[key]) revert AlreadyAnchored(sourceChainId, sourceTxHash);
        anchored[key] = true;
        anchorCount[cardId] += 1;

        emit PaymentAnchored(cardId, payer, merchant, amount, sourceChainId, sourceTxHash, paidAt, msg.sender, memo);
    }

    /// @notice The replay key for a source payment.
    function sourceKey(uint256 sourceChainId, bytes32 sourceTxHash) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceTxHash));
    }

    /// @notice Whether a given source payment has already been anchored here.
    function isAnchored(uint256 sourceChainId, bytes32 sourceTxHash) external view returns (bool) {
        return anchored[sourceKey(sourceChainId, sourceTxHash)];
    }
}
