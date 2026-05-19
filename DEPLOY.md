# Desplegar sin pagar (y con la PC apagada)

El dólar mayorista necesita un proceso Node con **WebSocket a A3** (no sirve Vercel serverless).

## Opción gratuita recomendada: Render Free + “keep-alive”

**Costo: USD 0.** Render duerme el servicio tras ~15 min sin visitas; un ping cada 14 minutos lo mantiene despierto casi todo el día.

### Pasos

1. Subí el repo a **GitHub** (privado; **no** subas `.env`).

2. [render.com](https://render.com) → cuenta gratis → **New** → **Blueprint**.

3. Conectá GitHub y usá el Blueprint **`render.yaml`** del repo (plan `free`).

4. Cuando pida variables, cargá:
   - `FUTURES_USER`
   - `FUTURES_PASSWORD`
   - El resto ya viene en el blueprint.

5. Al terminar el deploy, copiá tu URL pública, por ejemplo:  
   `https://dashboard-tc-noticias.onrender.com`

6. **Keep-alive (importante):** en GitHub → repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   - Nombre: `APP_URL`
   - Valor: tu URL **sin** barra final (ej. `https://dashboard-tc-noticias.onrender.com`)

   El workflow `.github/workflows/keep-alive.yml` hará ping a `/api/health` cada 14 minutos.

7. **Proyección diaria 9:00 ART:** configurá también el secret `PROJECTION_JOB_SECRET` en GitHub con el mismo valor que cargaste en Render. El workflow `.github/workflows/daily-projection.yml` llama a `/api/projection/daily-run` todos los días hábiles a las 9:00 ART.

8. Activá Actions: **Actions** → workflow **Keep alive** → **Run workflow** (una vez para probar). Luego probá **Daily projection** manualmente cuando quieras validar el guardado.

### Qué esperar (plan free)

| Aspecto | Comportamiento |
|---------|----------------|
| Costo | Gratis |
| Siempre encendido | Casi sí, si el keep-alive corre |
| Primer acceso tras rato sin uso | Puede tardar **30–60 s** (arranque en frío) |
| WebSocket A3 | Se reconecta al despertar el servidor |
| Historial proyección | En memoria (se pierde si Render reinicia el contenedor) |

**Alternativa al keep-alive de GitHub:** [UptimeRobot](https://uptimerobot.com) (gratis): monitor HTTP cada 5 min a `https://TU-URL/api/health`.

---

## Opción 100% gratis y siempre encendida (más trabajo): Oracle Cloud

Oracle ofrece VMs **Always Free** (sin tarjeta de crédito en muchos países, o con verificación mínima).

1. Creá una VM **ARM Ampere** (Ubuntu) en [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/).
2. Instalá Docker en la VM.
3. Cloná el repo, creá `.env` con tus credenciales.
4. `docker build -t dashboard-tc . && docker run -d --restart unless-stopped -p 80:3000 --env-file .env dashboard-tc`
5. Abrí el puerto 3000 en el firewall / Security List de Oracle.

Ventaja: no se duerme. Desventaja: configuración inicial ~30–60 minutos.

---

## Opciones de pago (solo si querés cero mantenimiento)

| Plataforma | Plan | Costo aprox. |
|------------|------|----------------|
| Railway | Hobby | ~USD 5/mes |
| Render | Starter | ~USD 7/mes |

Si más adelante querés cero cold starts, se puede cambiar Render a plan Starter o migrar a Railway.

---

## Variables de entorno (todas las opciones)

| Variable | Obligatoria |
|----------|-------------|
| `ENABLE_FUTURES` | `true` |
| `FUTURES_USER` | Sí |
| `FUTURES_PASSWORD` | Sí |
| `FUTURES_BASE_URL` | `https://api.remarkets.primary.com.ar` |
| `A3_MATRIZ_WS_URL` | `wss://matbarofex.primary.ventures/ws` |
| `A3_MD_TOPIC` | `md.rx_DDF_DLR_SPOT` |
| `SUPABASE_URL` | Sí, para historial persistente |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí, secreto de servidor |
| `SUPABASE_DAILY_PROJECTIONS_TABLE` | `daily_projections` |
| `PROJECTION_JOB_SECRET` | Sí, mismo valor en Render y GitHub |

---

## Verificar

1. `https://TU-URL/api/health` → `"ok": true`
2. Logs en Render: `[A3-WS] Suscrito a md.rx_DDF_DLR_SPOT`
3. El dashboard carga el USD mayorista

---

## Probar Docker en tu PC

```bash
docker build -t dashboard-tc .
docker run --rm -p 3000:3000 --env-file .env dashboard-tc
```

---

## Notas

- **Yahoo FX:** a veces bloquea IPs de datacenters; hay fallback Frankfurter (referencia diaria).
- **Vercel:** no usar para este proyecto (WebSocket).
- Con **Render free + keep-alive**, podés usar el dashboard desde el celular con la PC apagada.
