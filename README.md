# PanelSpotlight

Dashboard mensual de redes sociales y Meta Ads para los clientes de Spotlight.

Cada mañana, una tarea automática de GitHub consulta la API de Meta con tu token, guarda los datos de cada cliente en `data/` y el dashboard (`index.html`, publicado en GitHub Pages) los muestra. El token nunca aparece en el código ni en la página.

## Puesta en marcha

### 1. Sube el repositorio
Crea un repositorio llamado `PanelSpotlight` en GitHub y sube todos estos archivos, incluida la carpeta oculta `.github`.

> Si lo subes arrastrando archivos en la web de GitHub, la carpeta `.github` a veces no se sube. Revisa que exista `.github/workflows/actualizar-datos.yml` en el repo.

### 2. Guarda el token como secret
En el repo ve a **Settings → Secrets and variables → Actions → New repository secret**.
- Nombre: `META_TOKEN`
- Valor: el token de tu usuario del sistema de Meta Business

### 3. Agrega a tus clientes
Edita `config/clients.json`. Un bloque por cliente:

```json
{
  "id": "yvonne-larrieu",
  "name": "Yvonne Larrieu",
  "subtitle": "Caza Inmuebles · Orgánico y pagado en Instagram y Facebook",
  "adAccountId": "act_1234567890",
  "pageId": "1029384756",
  "igUserId": ""
}
```

- `id`: minúsculas y guiones, sin espacios. No lo cambies después, porque es el nombre de su carpeta de datos.
- `adAccountId`: en el Administrador de anuncios, es el número junto al nombre de la cuenta. Puede ir con o sin `act_`.
- `pageId`: en la página de Facebook, **Información → Transparencia de la página**, o en Meta Business Suite → Configuración.
- `igUserId`: déjalo vacío; se obtiene solo desde la página de Facebook vinculada.
- Si un cliente no tiene Ads o no tiene Facebook, deja ese campo vacío y esa sección saldrá en blanco.

### 4. Activa GitHub Pages
**Settings → Pages → Build and deployment → Deploy from a branch**, rama `main`, carpeta `/ (root)`. Guarda. En un minuto tendrás el link del panel.

### 5. Corre la primera actualización
**Actions → Actualizar datos de Meta → Run workflow**, y en *meses* escribe `6` para traer los últimos seis meses. Luego se actualiza solo todos los días a las 6:17 a. m. de Lima.

## Qué hay que saber

- **Historial de seguidores.** Meta no da el historial de seguidores, solo el número actual. El panel guarda una foto diaria desde la primera ejecución, así que la curva y la comparación mes a mes se completan con el tiempo. Los meses anteriores a la primera ejecución no tendrán dato de seguidores, pero sí posts, campañas y anuncios.
- **Los datos son públicos.** Con GitHub Pages en un repo público, cualquiera con el link puede ver el panel y los archivos de `data/`. El siguiente paso es ponerle login.
- **Si algo falla**, el panel muestra un aviso amarillo con el detalle, y el registro completo está en la pestaña **Actions**. Lo más común es que al usuario del sistema le falte un activo asignado o un permiso.
- **Permisos del token:** `ads_read`, `read_insights`, `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights`, `business_management`.
- **Versión de la API:** el script usa `v23.0`. Si Meta la retira, agrega una variable `GRAPH_VERSION` en el workflow con la versión nueva.

## Estructura

```
index.html                         Dashboard
config/clients.json                Lista de clientes
scripts/fetch-meta.mjs             Script que consulta la API de Meta
.github/workflows/actualizar-datos.yml  Tarea diaria
data/                              Datos generados (no editar a mano)
```
