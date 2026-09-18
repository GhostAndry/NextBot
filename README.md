# NextBot

Scalable Discord bot with **Redis leader election** (hot-standby failover), modular feature set, Prisma ORM (SQLite/Postgres).

## Features

Commands are grouped by category:

- **🛡️ Moderation** (`/mod`) — ban, kick, mute, unmute, warn, warnings, clearwarns, purge, slowmode, lock, unlock
- **🎫 Tickets** (`/ticket`) — open, close, claim, add/remove user, transcript export
- **📈 Levels** (`/level`) — XP from messages, rank card, leaderboard, role rewards
- **💰 Economy** (`/economy`) — wallet, bank, daily streak, work, transfer, rob, leaderboard
- **🎲 Games** (`/blackjack`, `/poker`) — blackjack vs dealer, Texas Hold'em multiplayer
- **🔊 Voice** (`/voice`) — multi temp voice stile VoiceMaster: 👑 owner, rename, lock, limit, kick, transfer, claim
- **🔊 Voice utility** (`/voicemove`) — bot enters VC, moves all members
- **🎵 Soundboard** (`/soundboard`) — upload, play in VC, list, rename, delete
- **🎉 Fun** (`/fun`) — 8ball, coinflip, dice, rps, choose, rate
- **⚙️ General** (`/help`, `/settings`, `/admin`) — help, per-guild settings panel, deploy/admin
- **🎉 Autorole + Welcome** — automatic role on join, configurable welcome message
- **Hot-standby failover** — two nodes share a Redis lock; only the leader connects to Discord

## Comandi

Lista completa dei comandi slash. Per l'elenco aggiornato a runtime usa `/help tutto:true`.

### 🛡️ Moderazione — `/mod`
| Subcommand | Descrizione |
| --- | --- |
| `ban <utente> [motivo] [durata] [giorni_messaggi]` | Banna un utente (temporaneo opzionale, 0-7gg di messaggi) |
| `kick <utente> [motivo]` | Espelli un utente |
| `mute <utente> <durata> [motivo]` | Silenzia un utente (es. `10m`, `1h`, `1d`) |
| `unmute <utente>` | Rimuovi il timeout da un utente |
| `warn <utente> <motivo>` | Registra un avviso |
| `warnings <utente>` | Mostra gli avvisi di un utente |
| `clearwarns <utente>` | Cancella gli avvisi di un utente |
| `purge <quantità> [utente]` | Elimina in blocco 1-100 messaggi (opz. solo di un utente) |
| `slowmode <secondi>` | Imposta modalità lenta (0-21600s) sul canale attuale |
| `lock` / `unlock [canale]` | Blocca/sblocca un canale (default: attuale) |

### 🎫 Ticket — `/ticket`
| Subcommand | Descrizione |
| --- | --- |
| `open` | Apri un nuovo ticket (form con oggetto + descrizione) |
| `panel [canale]` | Invia il pannello con il bottone "Apri un ticket" |
| `close` | Chiudi il ticket attuale (con conferma) |
| `add <utente>` | Aggiungi un utente al ticket |
| `remove <utente>` | Rimuovi un utente dal ticket (solo staff) |
| `claim` | Prendi in carico il ticket |
| `transcript` | Salva e invia la trascrizione del ticket |

### 📈 Livelli — `/level`
| Subcommand | Descrizione |
| --- | --- |
| `rank [utente]` | Mostra la card del livello |
| `leaderboard` | Classifica XP del server |
| `set <livello> <utente>` | Imposta un livello (solo staff) |
| `add <xp> <utente>` | Aggiungi XP (solo staff) |
| `reset <utente>` | Azzera XP/level (solo staff) |

### 💰 Economia — `/economy`
| Subcommand | Descrizione |
| --- | --- |
| `balance [utente]` | Controlla il saldo |
| `daily` | Riscuoti la ricompensa giornaliera (cooldown 22h, streak con bonus) |
| `work` | Lavora per guadagnare monete (cooldown 1h) |
| `deposit <importo>` | Sposta dal portafoglio alla banca |
| `withdraw <importo>` | Sposta dalla banca al portafoglio |
| `give <utente> <importo>` | Dai monete a un utente |
| `rob <utente>` | Prova a derubare (40% successo, multa 50 se scoperti) |
| `leaderboard` | Classifica portafoglio + banca |

### 🎲 Giochi — `/blackjack`, `/poker`
**Blackjack**
| Subcommand | Descrizione |
| --- | --- |
| `start <puntata>` | Inizia una nuova partita |
| `hit` / `stand` / `double` | Azioni di gioco (anche via bottoni) |

**Poker (Texas Hold'em multiplayer)**
| Subcommand | Descrizione |
| --- | --- |
| `create <buyIn>` | Crea un tavolo |
| `join <buyIn>` | Siedi al tavolo del canale |
| `leave` | Esci dal tavolo (solo in lobby) |
| `start` | L'host avvia la mano |
| `call` / `check` / `fold` / `raise <importo>` | Azioni di gioco |
| `state` | Stato del tavolo |
| `end` | Chiudi il tavolo e rimborsa |

### 🔊 Voce — `/voice`, `/voicemove`, `vkick` (context menu)
**`/voice` — gestione canale temporaneo (devi essere owner)**
| Subcommand | Descrizione |
| --- | --- |
| `create <nome> [minuti]` | Crea canale testuale temporaneo (legacy staff) |
| `rename <nome>` | Rinomina il tuo canale |
| `lock` / `unlock` | Blocca/sblocca join al tuo canale |
| `limit <numero>` | Imposta limite utenti (0=illimitato) |
| `kick <utente>` | Caccia un membro (autocomplete membri del canale) |
| `permit <utente>` | Riammetti un utente precedentemente bloccato |
| `transfer <utente>` | Trasferisci la proprietà (autocomplete membri del canale) |
| `claim` | Rivendica un canale orfano |
| `info` | Mostra la configurazione del tuo canale |

**`/voicemove` — sposta tutti i membri (singolo comando, no subcommand)**
| Comando | Descrizione |
| --- | --- |
| `/voicemove` | Il bot entra nel tuo canale vocale. Trascinalo nel canale di destinazione: tutti i membri attuali nel tuo canale verranno spostati lì. Esce automaticamente dopo 30s di inattività. |

**Context menu `vkick`** — tasto destro su un membro → Apps → VKick. Caccia il membro dal tuo canale.

### 🎵 Soundboard — `/soundboard`
| Subcommand | Descrizione |
| --- | --- |
| `add <nome> <file>` | Aggiungi un suono (carica un file audio) |
| `play <nome>` | Riproduci nel tuo canale vocale (cooldown 60s, autocomplete) |
| `list` | Elenco suoni |
| `delete <nome>` | Elimina un tuo suono (autocomplete) |
| `rename <vecchio> <nuovo>` | Rinomina (autocomplete) |
| `stop` | Ferma la riproduzione ed esci dal canale |

### 🎉 Divertimento — `/fun`
| Subcommand | Descrizione |
| --- | --- |
| `8ball <domanda>` | Palla magica |
| `coinflip` | Testa o croce |
| `dice <facce>` | Lancia un dado |
| `rps <scelta>` | Sasso, carta, forbice |
| `choose <opzioni>` | Scegli tra opzioni separate da virgole |
| `rate <cosa>` | Vota qualcosa da 1 a 10 |

### ⚙️ Generale — `/help`, `/settings`, `/admin`
- **`/help [categoria] [tutto]`** — Lista comandi raggruppati per categoria
- **`/settings <categoria> <azione>`** — Pannello per modificare la config del guild (autorole, ticket category, livelli, voice hub, cooldown, …). I tunable globali restano in `config.json`.
- **`/admin <azione>`** — Comandi admin: setup hub ticket/voice, deploy/wipe comandi Discord.

## Quick start (no Docker, no Redis)

```bash
cp .env.test.example .env
# edit .env and put your DISCORD_BOT_TOKEN
npm install
npm start
```

This runs in **single-node mode** with SQLite and no leader election. Perfect for local testing.

## Production setup (with Redis failover)

```bash
# Terminal 1: install Redis and start it
redis-server

# Terminal 2: bot1
NODE_ID=bot1 DISCORD_BOT_TOKEN=xxx npm start

# Terminal 3: bot2 (same token)
NODE_ID=bot2 DISCORD_BOT_TOKEN=xxx npm start
```

Only one will be the leader at a time. Kill the leader and the other takes over within ~15 seconds.

## Project layout

```
src/
├── index.js                  Bootstrap + leader election loop
├── config.js                 Loads config.json + .env; exposes the merged tree
├── deploy-commands.js        Register slash commands
│
├── db/
│   ├── prisma.js             Prisma client singleton
│   ├── index.js              Init dispatcher ($connect/$disconnect)
│   └── repo.js               All read/write helpers (async, one section per domain)
│
├── prisma/
│   └── schema.prisma         Prisma schema (single source of truth)
│
├── events/                   Discord.js event handlers
│   ├── ready.js
│   ├── interactionCreate.js  Routes slash commands + components to handlers
│   ├── messageCreate.js      XP gain on messages (per-guild tunables)
│   ├── voiceStateUpdate.js   Temp voice channels (per-guild tunables)
│   ├── channelDelete.js      Cleanup tickets/temp channels on deletion
│   └── guildMemberAdd.js     Autorole + welcome message

├── commands/                 Slash commands grouped by category
│   ├── moderation/mod.js
│   ├── tickets/ticket.js
│   ├── levels/level.js
│   ├── economy/economy.js
│   ├── games/blackjack.js + blackjack-cards.js
│   ├── games/poker.js
│   ├── voice/voicemove.js
│   ├── voice/tempchannel.js   `/voice` - multi temp voice stile VoiceMaster (👑 owner, rename, lock, kick, transfer, claim)
│                                  impostazioni persistenti via tabella VoiceRoom
│   ├── soundboard/soundboard.js
│   ├── fun/fun.js
│   └── general/help.js
│   └── general/settings.js   Per-guild config panel (autorole, ticket, mod, levels, voice, tunables)
│   └── general/admin.js      Admin: deploy diff-aware, ticket/voice setup

├── handlers/
│   ├── registry.js           Loads commands/events, deploys on ready
│   └── categories.js         Help-page grouping + emoji labels

├── services/                 Cross-cutting logic
│   ├── leader-elector.js     Redis lock acquire/renew/release
│   ├── bot.js                Discord client lifecycle
│   ├── ticket-transcript.js  Transcript export
│   ├── poker-cards.js        Pure card/hand evaluation
│   ├── poker-game.js         Poker state machine, betting, showdown
│   ├── soundboard-player.js  Per-guild voice player
│   ├── settings-resolver.js  Tunable resolution: per-guild DB override > global config.json
│   └── voice-state-tracker.js  In-memory Map of temp voice channels by owner (👑 lookup O(1))
│
└── utils/
    ├── logger.js
    └── helpers.js            Embed builders, duration parsing, permissions

data/
├── nextbot.db                SQLite database
└── sounds/<guild_id>/        Soundboard files
```

## Configuration

Three files, clean separation:

- **`config.json`** — every tunable: thresholds, IDs, feature flags, paths. Edit values directly here.
- **`.env`** — Discord credentials + `DATABASE_URL` for Prisma.
- **`prisma/schema.prisma`** — database schema (single source of truth).

**`src/config.js`** is the only place that knows how to load config.json + .env. Other modules just `require('./config')` and read `config.redis.host`, `config.features.tickets.enabled`, etc. No duplicate parsing or env-reading logic anywhere else.

To switch features on/off, change IDs, tune thresholds, or switch DB/Redis: edit `config.json`. Restart the bot.

## Database (Prisma)

Prisma ORM manages the schema. Two providers are supported (sqlite default, postgres optional). Credentials live in `config.json` under `database`. The `src/db/prisma.js` module reads `config.database.driver` at startup and builds the right `DATABASE_URL`, so no `.env` entries are required for the DB.

### SQLite (default)

```json
"database": {
  "driver": "sqlite",
  "sqlite": { "path": "./data/nextbot.db" }
}
```

```bash
npm run db:setup      # create schema + generate client
npm start
```

### PostgreSQL

```json
"database": {
  "driver": "postgres",
  "postgres": {
    "host": "127.0.0.1",
    "port": 5432,
    "user": "nextbot",
    "password": "secret",
    "database": "nextbot",
    "schema": "public"
  }
}
```

```bash
npm run db:setup      # pushes to Postgres + generates the matching client
npm start
```

`scripts/prisma-setup.js` reads `config.json`, picks the right schema (`prisma/schema.prisma` for sqlite, `prisma/schema.postgres.prisma` for postgres), and runs `prisma db push` + `prisma generate`. Switching providers always requires running this setup so the generated client matches the runtime driver.

All DB access goes through `src/db/repo.js` (async). Never write raw Prisma queries in commands/services.

## Slash commands deployment

Commands auto-register on `ready`. Deployment is **diff-aware**: it only removes commands that no longer exist in code, then upserts the current set. Untouched commands stay live the whole time (no flicker).

```bash
npm run deploy                    # clean stale + redeploy (safe default)
npm run deploy -- --dry-run       # preview diff, change nothing
npm run deploy -- --wipe          # delete everything, then redeploy
npm run deploy -- --only-clean    # delete stale, no redeploy
npm run deploy -- --remove work backup   # delete specific commands by name
npm run deploy:unregister         # unregister ALL guild commands on EVERY guild
npm run deploy:unregister-global  # same, plus global commands
```

### From Discord (admin only)

```
/admin deploy sync      # clean stale + redeploy
/admin deploy wipe      # wipe everything + redeploy
/admin deploy dryrun    # preview diff
/admin deploy remove    # delete specific commands by name
/admin deploy unregister # unregister ALL guild commands on EVERY guild
```

If `DISCORD_GUILD_ID` is set, scope is that guild (instant). Otherwise scope is global (up to 1 hour propagation).

## Multi temp voice (`/voice`)

Stile VoiceMaster / TempVoice con **più hub per guild**: ogni hub è un canale vocale che, quando un utente vi entra, gli genera automaticamente un canale privato 👑.

### Configurazione hub

Ogni hub è una riga nella tabella `VoiceHub`. Lo staff può aggiungere/rimuovere hub tramite `/settings`:

```
/settings voice add canale:#Crea-Canale nome:"Hub Generale"
/settings voice add canale:#VIP-Entry nome:"VIP Lounge"
/settings voice list
/settings voice rename canale:#VIP-Entry nome:"VIP Premium"
/settings voice default canale:#VIP-Entry
/settings voice remove canale:#Vecchio-Hub
```

Quando aggiungi un hub, chi vi entra crea temp voice **sotto lo stesso parent** dell'hub, con prefisso 👑. Il primo hub aggiunto viene segnato automaticamente come default.

Il legacy `/settings voice hub canale:X` continua a funzionare e aggiunge anche il canale alla lista degli hub.

### Comandi owner del canale

Quando un utente è dentro un temp voice di sua proprietà, può gestirlo con `/voice`:

| Azione | Comando | Bottone pannello |
|---|---|---|
| Rinominare | `/voice rename nome:...` | ✏️ Rename → modal |
| Bloccare / sbloccare | `/voice lock`, `/voice unlock` | 🔒 Lock / 🔓 Unlock |
| Cambiare limite utenti | `/voice limit numero:4` | 👥 Limit → modal |
| Cacciare (kick) | `/voice kick utente:@x` | 👢 Kick → modal |
| Riammettere (dopo un kick) | `/voice permit utente:@x` | — |
| Trasferire proprietà | `/voice transfer utente:@x` | 👑 Owner → modal |
| Rivendicare (owner assente) | `/voice claim` | 🙋 Claim |
| Refresh info | `/voice info` | 🔄 Refresh |

Quando l'owner lascia il canale, il primo utente rimasto può fare `/voice claim` per diventare il nuovo proprietario: il canale viene rinominato con il prefisso 👑 + il suo nome.

### Persistenza delle impostazioni per owner

Quando un canale temp si svuota e viene eliminato, **le impostazioni non vanno perse**: lock, lista bloccati, limite utenti e nome personalizzato vengono salvati nella tabella `voice_rooms` con chiave `(guildId, ownerId, hubChannelId)`.

Quando lo stesso utente (o uno che fa `/voice transfer` o `/voice claim`) rientra nello stesso hub, il canale viene ricreato con tutte le impostazioni precedenti:

- Stessa `locked` (canale bloccato o aperto)
- Stessa lista `blocked` (utenti che non possono rientrare)
- Stesso `userLimit`
- Permessi di lock applicati subito al nuovo canale

Il salvataggio avviene due volte:

1. **Live**: ogni volta che `/voice <lock|unlock|kick|permit|limit|rename|transfer>` viene eseguito, lo snapshot viene aggiornato (così se il bot crasha all'improvviso, al rientro abbiamo già lo stato corrente).
2. **Alla cancellazione**: prima di `repo.removeTempChannel()`, lo snapshot viene salvato con i valori correnti del canale.

Esempio: Mario blocca Luca dal suo temp voice. Il canale si svuota dopo 30s. Mario rientra nell'hub: il canale si ricrea con Luca ancora bloccato, e se Mario non fa `/voice permit`, Luca non può rientrare.

### Multi-hub: setup tipico

Esempio per un server con due livelli di privacy:

```
1. Crea due canali hub:
   - "Crea Canale" (categoria Generale)
   - "VIP Lounge" (categoria VIP, con restrizioni di ruolo)
2. /settings voice add canale:#Crea-Canale nome:"Hub Generale"
3. /settings voice add canale:#VIP-Entry nome:"VIP Lounge"
4. Gli utenti normali entrano in #Crea-Canale → temp voice pubblici
5. Gli utenti VIP entrano in #VIP-Entry → temp voice sotto categoria VIP
```

Ogni hub è completamente indipendente: i temp voice creati da un hub non appaiono mai come generati da un altro.

### Cache in-memory

Il modulo `src/services/voice-state-tracker.js` tiene un `Map` aggiornato con `{guildId, channelId, ownerId, hubChannelId}` per tutte le temp voice attive. Viene popolato:

- all'avvio del bot (sync dal DB)
- quando un nuovo canale temp viene aperto (evento `voiceStateUpdate`)
- quando l'owner cambia (`/voice transfer`, `/voice claim`)

Viene ripulito quando:

- il canale temp viene eliminato (evento `channelDelete`)

Per la mappa hub→canaliId, `voiceStateUpdate` mantiene una cache locale con TTL 30s invalidabile tramite `invalidateHubCache(guildId)` (chiamata da `/settings voice add/remove`).

Il `Map` permette lookup O(1) per i dispatcher dei bottoni/modali, evitando query al DB su ogni interazione.

## Adding a new command

1. Drop a file in the matching category folder (`src/commands/<category>/foo.js`).
2. Export `data` (SlashCommandBuilder) and `execute(interaction)`.
3. Optionally export `handleComponent(interaction)` for button/menu handlers.
4. Restart the bot — commands auto-deploy on `ready`.

Each command is self-contained: dispatch + subcommand table at the top, helper functions at the bottom, no shared command file exceeding ~250 lines.

## Per-guild settings (`/settings`)

Everything that varies per-server lives in the database (`GuildConfig` table). The `/settings` command is the single panel for managing it — no need to edit `config.json` and restart for routine tweaks.

### Autorole + welcome

```
/settings autorole set ruolo:@Membro
/settings autorole toggle attivo:false
/settings autorole disable

/settings welcome channel canale:#benvenuto
/settings welcome message testo:"Benvenuto su {server}, {user}!"
/settings welcome toggle attivo:true
/settings welcome disable
```

Welcome message supports placeholders: `{user}` (mention), `{username}`, `{server}`. The bot needs the `GuildMembers` intent and the role must be below the bot's highest role.

### Tickets, voice, mod, levels

```
/settings ticket category categoria:#Ticket
/settings ticket log canale:#ticket-log
/settings ticket max quantita:3
/settings ticket transcript attivo:true

/settings voice hub canale:#Crea Canale
/settings voice autodelete secondi:30
/settings voice userlimit limite:4

/settings mod logchannel canale:#mod-log
/settings mod muterole ruolo:@Muted
/settings mod maxwarns quantita:3
/settings mod warnaction azione:mute

/settings levels xp minimo:15 massimo:25
/settings levels cooldown secondi:60
/settings levels announce canale:#livelli
/settings levels toggle attivo:true
```

### Raw tunables

For everything that doesn't have a dedicated subcommand (or for power users), use the generic tunable interface:

```
/settings tunable set chiave:xpMin valore:20
/settings tunable reset chiave:xpMin
/settings tunable list
```

Every tunable supports a per-guild override via `/settings tunable set` and falls back to `config.json` when the override is missing. The bot hot-reads the override on every event, so changes apply immediately — no restart required.

Adding a new tunable is one edit to `src/services/settings-resolver.js` (`KNOWN_SETTINGS`), then it appears in autocomplete and in `/settings tunable list`.

### Inspecting what's configured

```
/settings show                  # overview of every area
/settings show sezione:ticket   # full detail of one area
```
