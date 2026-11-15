# Mormon Bridge

A Mormon Bridge card game for phones. Anyone with the link can play, with no accounts. It runs on Cloudflare's free plan.

## House rules built in

- The first round deals the biggest hand (7 cards by default). Each round after that deals one card fewer, down to 1, then back up to the biggest hand: 7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7.
- After the deal, the next card is turned up and its suit is trump. If no card is left over, that round has no trump.
- Everyone bids at the same time, in secret. The bids appear once the last one is in.
- You must follow the suit that was led if you can.
- You can't lead trump until someone has played a trump that round, unless trump is all you have.
- Make your bid exactly and you score 5 points plus 5 per trick you bid. Miss it, over or under, and you lose 5.
- The host's settings:
  - Biggest hand size.
  - Whether to go back up after the 1-card round.
  - An optional "dealer fixes it" rule: if the bids add up to the number of tricks, the dealer has to change their bid by one.

## Put it online (one time, about 5 minutes)

You need a free Cloudflare account and Node.js. Both are already set up on this computer.

1. Open a terminal in this folder.
2. Log in to Cloudflare. A browser window opens; sign in or create a free account there.
   ```
   npx wrangler login
   ```
3. Publish the game:
   ```
   npx wrangler deploy
   ```
   It prints your link, something like `https://mormon-bridge.<your-name>.workers.dev`. Send that link to your friends.

To publish changes later, run `npx wrangler deploy` again.

## How to play

1. One person opens the link, types their name and taps **Start a new game**. That person is the host.
2. Tap **Invite** to send the link (it includes the 4-letter game code) to the group text.
3. Everyone else opens the link, types their name and taps **Join**.
4. The host taps **Deal the first round**.
5. Tap **Cards** at the top of the page to pick a card style for your own phone: Classic, Casino, Neon, Vintage, Big Print or Web Slinger.

If someone's phone drops out, the game keeps their seat. When they open the link again on the same phone, they're back in. If they're gone for good, anyone else at the table can tap **Play for them** to make their move: the game bids 0 for them, or plays their lowest legal card.

Games are deleted after a week with no play.

## For tinkering

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the game on your computer at http://localhost:8787 |
| `npm test` | Checks the rules by playing hundreds of simulated games |
| `npm run test:live` | Plays a full game against the running server (start `npm run dev` first) |

| File | What's in it |
| --- | --- |
| `src/game.js` | The rules and scoring |
| `src/room.js` | The game server. It keeps everyone's hands hidden from the other players |
| `src/index.js` | Starts new games and connects phones to the right game |
| `public/index.html` | The page everyone plays on |
