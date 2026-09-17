# NextBot — Failover Architecture

## Obiettivo
2 istanze del bot Discord partono insieme. La prima a scrivere il lock su Redis diventa **leader** (bot attivo). La seconda resta **standby** (in ascolto su Redis). Se il leader cade, lo standby prende il lock e diventa leader. Quando l'istanza caduta riparte (via `docker restart: always`), trova il lock occupato e torna in standby.

## Componenti

```
┌──────────────────────┐    ┌──────────────────────┐
│  Nodo bot1 (lead)    │    │  Nodo bot2 (standby) │
│  Docker container    │    │  Docker container    │
│  restart: always     │    │  restart: always     │
└──────────┬───────────┘    └──────────┬───────────┘
           │                           │
           │  SET NX EX (lock)         │  GET (poll 2s)
           └───────────┬───────────────┘
                       ▼
              ┌─────────────────┐
              │  Redis          │
              │  key: nextbot:  │
              │       leader    │
              │  TTL: 15s       │
              │  value: node_id │
              └─────────────────┘
```

## Flusso

**Avvio:**
1. Entrambi i container partono.
2. Entrambi provano `SET nextbot:leader <node_id> NX EX 15`.
3. Chi riesce per primo → **leader** → chiama `bot.start(TOKEN)`.
4. L'altro → **standby** → `while True: if exists(lock) wait else take lock`.

**Lock renewal (solo leader):**
- Ogni 10s il leader esegue uno script Lua che rinnova il TTL **solo se il value è ancora il suo node_id** (controllo di proprietà).
- Pattern: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end`.

**Failover:**
- Se il leader crasha, dopo max 15s il lock scade.
- Lo standby al prossimo poll (ogni 2s) trova `exists(lock) == 0` → prende il lock → diventa leader → avvia il bot.
- ⚠️ Wrappare `bot.start()` in `try/except/finally` + `r.delete(LOCK_KEY)` nel `finally`. Altrimenti il TTL deve scadere prima del failover (attesa extra di 15s).

**Recovery:**
- L'istanza caduta riparte via `docker restart: always`.
- Al riavvio tenta `SET NX` → fallisce (lock occupato dall'altro) → entra in standby loop.

## Decisions / Why

- **Lock con TTL**: il solo meccanico per il failover. Se il container muore, il lock si libera da solo senza intervento esterno.
- **Lua script per renewal**: rinnovare solo se possessore garantisce che uno standby non possa accidentalmente rinnovare il lock del leader.
- **Polling 2s sullo standby**: bassa latenza percepita (< 2s + 15s TTL worst case ≈ 17s) senza bisogno di keyspace notifications Redis (più semplice, meno edge case).
- **`restart: always` su entrambi**: Docker riparte l'istanza caduta automaticamente; il codice poi si auto-posiziona come standby.
- **Stesso `DISCORD_TOKEN` su entrambi**: ma solo uno alla volta chiama `bot.start`. Due connessioni Gateway simultanee con lo stesso token fanno chiudere la seconda da Discord.
- **`node_id` come value del lock**: identifica chi possiede il lock, serve per il rinnovo sicuro.

## Variabili / config

- `DISCORD_TOKEN` (env, identico su entrambi i container)
- `REDIS_HOST`, `REDIS_PORT`
- `LOCK_KEY` = `nextbot:leader`
- `LOCK_TTL` = 15 secondi
- `RENEW_INTERVAL` = 10 secondi (TTL/2 = margine di sicurezza)
- `STANDBY_POLL` = 2 secondi

## TODO futuri

- Sostituire Redis single-node con **Redis Sentinel** per HA di Redis stesso (altrimenti Redis è il single point of failure).
- Aggiungere **Postgres** per stato persistente (queue persistente, config, dati utente) con PgBouncer davanti per connection pooling.
- Logging strutturato + metriche (Prometheus) su entrambi i nodi per capire chi era leader quando.
- Notifica di failover (webhook/canale Discord admin) quando uno standby diventa leader.
