'use strict';

// Deck and 5-card hand evaluation for Texas Hold'em.
// Card representation: { s: '♠'|'♥'|'♦'|'♣', v: '2'..'10'|'J'|'Q'|'K'|'A' }.

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const HAND_RANKS = {
  high: 0,
  pair: 1,
  twoPair: 2,
  three: 3,
  straight: 4,
  flush: 5,
  full: 6,
  four: 7,
  straightFlush: 8,
};

function cardValue(v) {
  return VALUES.indexOf(v);
}

function cardString(c) {
  return `${c.v}${c.s}`;
}

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const v of VALUES) deck.push({ s, v });

  // Fisher-Yates shuffle.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function deal(deck, n) {
  return deck.splice(deck.length - n, n);
}

function popCard(deck) {
  return deck.pop();
}

// --- 5-card evaluator ------------------------------------------------------

// Evaluate a 5-card hand and return a score. Higher score = better hand.
// The score encodes the hand rank in the high bits so that two hands of
// different ranks always sort correctly even if their kicker values match.
function evaluate5(cards) {
  const ranks = cards.map((c) => cardValue(c.v)).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.s === cards[0].s);

  const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = -1;
  if (uniqueRanks.length === 5 && uniqueRanks[0] - uniqueRanks[4] === 4) {
    straightHigh = uniqueRanks[0];
  } else if (
    uniqueRanks.length === 5 &&
    uniqueRanks[0] === 12 &&
    uniqueRanks[1] === 3 &&
    uniqueRanks[2] === 2 &&
    uniqueRanks[3] === 1 &&
    uniqueRanks[4] === 0
  ) {
    // A-2-3-4-5 low straight. Treat 5 as the high card for comparison.
    straightHigh = 3;
  }

  const counts = countRanks(ranks);
  const grouped = Object.entries(counts)
    .map(([r, c]) => ({ r: parseInt(r, 10), c }))
    .sort((a, b) => b.c - a.c || b.r - a.r);

  if (isFlush && straightHigh !== -1) {
    return { rank: HAND_RANKS.straightFlush, score: 8_000_000 + straightHigh, cards };
  }
  if (grouped[0].c === 4) {
    return { rank: HAND_RANKS.four, score: 7_000_000 + grouped[0].r, cards };
  }
  if (grouped[0].c === 3 && grouped[1]?.c === 2) {
    return { rank: HAND_RANKS.full, score: 6_000_000 + grouped[0].r, cards };
  }
  if (isFlush) {
    return { rank: HAND_RANKS.flush, score: 5_000_000 + tiebreak(ranks.slice(0, 4)), cards };
  }
  if (straightHigh !== -1) {
    return { rank: HAND_RANKS.straight, score: 4_000_000 + straightHigh, cards };
  }
  if (grouped[0].c === 3) {
    return { rank: HAND_RANKS.three, score: 3_000_000 + grouped[0].r, cards };
  }
  if (grouped[0].c === 2 && grouped[1]?.c === 2) {
    return { rank: HAND_RANKS.twoPair, score: 2_000_000 + grouped[0].r * 100 + grouped[1].r, cards };
  }
  if (grouped[0].c === 2) {
    return { rank: HAND_RANKS.pair, score: 1_000_000 + grouped[0].r * 100 + tiebreak(ranks.filter((r) => r !== grouped[0].r)), cards };
  }
  return { rank: HAND_RANKS.high, score: tiebreak(ranks.slice(0, 5)), cards };
}

function countRanks(ranks) {
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  return counts;
}

function tiebreak(ranks) {
  // Pack 4 ranks into a single comparator: rank[i] * 16^(3-i).
  return ranks.slice(0, 4).reduce((acc, r, i) => acc + r * Math.pow(16, 3 - i), 0);
}

// --- 7-card evaluator ------------------------------------------------------

function bestHandOf7(cards7) {
  // Try all 21 5-card subsets from 7 cards, keep the best.
  let best = null;
  for (let i = 0; i < cards7.length; i++) {
    for (let j = i + 1; j < cards7.length; j++) {
      const five = cards7.filter((_, k) => k !== i && k !== j);
      const evalResult = evaluate5(five);
      if (!best || evalResult.score > best.score) best = evalResult;
    }
  }
  return best;
}

module.exports = {
  SUITS, VALUES, HAND_RANKS,
  cardValue, cardString, newDeck, deal, popCard, evaluate5, bestHandOf7,
};
