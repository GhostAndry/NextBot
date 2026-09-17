'use strict';

// Pure card-and-hand helpers for blackjack. No Discord or DB imports here so
// this stays trivially unit-testable.

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function cardValue(c) {
  if (['J', 'Q', 'K'].includes(c.v)) return 10;
  if (c.v === 'A') return 11;
  return parseInt(c.v, 10);
}

function cardString(c) {
  return `${c.v}${c.s}`;
}

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const v of VALUES) deck.push({ s, v });

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

// Hand total: aces count as 11 unless they'd bust, then as 1.
function handTotal(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += cardValue(c);
    if (c.v === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function handStr(hand, hideFirst = false) {
  if (hideFirst) {
    return `🂠 ${hand.slice(1).map(cardString).join(' ')}`;
  }
  return hand.map(cardString).join(' ');
}

module.exports = { cardValue, cardString, newDeck, deal, popCard, handTotal, handStr };
