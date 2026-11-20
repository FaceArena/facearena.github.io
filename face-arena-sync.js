(() => {
  const SUPABASE_URL = "https://nvvkmjeobnnxlrpiuisf.supabase.co";
  const SUPABASE_KEY = "sb_publishable_-a7Qjy5NL3ZUaKfLpIi4Dg_x2hzmNKE";
  const WORKER_URL = "https://face-arena.featuresfaded.workers.dev";
  const EVENT = "face-arena-snapshot";

  function friendlyError(error, fallback = "Что-то пошло не так. Попробуйте ещё раз.") {
    if (error) console.warn("[FACE ARENA handled error]", error);
    const raw = String(error?.message || error || "").trim();
    const message = raw.toLowerCase();
    if (/этот никнейм уже занят/i.test(message)) return "Этот никнейм уже занят. Выберите другой.";
    if (/не подходит для участия/i.test(message)) return "Эта фотография не подходит для участия. Выберите другую.";
    if (/слишком много попыток проверки/i.test(message)) return "Слишком много попыток. Подождите 10 минут и попробуйте снова.";
    if (/для голосования нужен подтверждённый аккаунт/i.test(message)) return "Подтвердите email, чтобы голосовать.";
    if (/лимит голосов за 10 минут/i.test(message)) return "Слишком много голосов за короткое время. Подождите 10 минут и попробуйте снова.";
    if (/дневной лимит голосов/i.test(message)) return "На сегодня достигнут лимит голосов. Попробуйте завтра.";
    if (!message) return fallback;
    if (/invalid login credentials|invalid email or password|email or password is incorrect/.test(message)) return "Неверный email или пароль.";
    if (/email not confirmed|email_not_confirmed|confirm your email/.test(message)) return "Подтвердите email по ссылке в письме, затем войдите.";
    if (/user already registered|already registered|email.*already.*(exist|use)/.test(message)) return "Аккаунт с таким email уже существует. Попробуйте войти.";
    if (/password.*(at least|minimum|min\.? length)|weak_password|password should be/.test(message)) return "Пароль слишком короткий или не соответствует требованиям.";
    if (/rate limit|too many requests|too many attempts|request rate/.test(message)) return "Слишком много попыток. Подождите немного и попробуйте снова.";
    if (/fetch failed|failed to fetch|networkerror|network request failed|load failed|internet disconnected|offline/.test(message)) return "Не удалось подключиться. Проверьте интернет и попробуйте снова.";
    if (/jwt expired|session.*(expired|missing)|refresh token|not authenticated|unauthorized|401/.test(message)) return "Сеанс завершён. Войдите в аккаунт снова.";
    if (/row.level security|permission denied|not allowed|forbidden|403|insufficient privilege/.test(message)) return "Недостаточно прав для этого действия.";
    if (/file.*too large|payload too large|entity too large|maximum.*size|size.*limit/.test(message)) return "Файл слишком большой. Выберите фотографию меньшего размера.";
    if (/unsupported.*(media|file|type)|invalid.*mime|content.type|file type/.test(message)) return "Формат файла не поддерживается. Выберите JPEG, PNG или WebP.";
    if (/not found|does not exist|no rows/.test(message)) return "Не удалось найти нужные данные. Обновите страницу и попробуйте снова.";
    if (/timeout|timed out|deadline exceeded|temporarily unavailable|503|502|500/.test(message)) return "Сервис временно недоступен. Попробуйте немного позже.";
    return fallback;
  }
  window.FaceArenaErrors = Object.freeze({ message: friendlyError });

  class FaceArenaSync {
    constructor() {
      this.client = null;
      this.user = null;
      this.channel = null;
      this.visibilityChannel = null;
      this.notifications = [];
      this.ready = false;
      this.loading = false;
      this.lastSnapshot = null;
      this.serverTimeOffset = 0;
      this.clockSyncTimer = null;
      this.authGeneration = 0;
      this.privacyOverrides = new Map();
      this.photoUrlRefreshTimer = null;
      this.photoUrlRefreshInFlight = false;
      this.photoUrlsExpiresAt = 0;
      this.snapshotReloadTimer = null;
      this.photoUrlVisibilityHandler = () => {
        if (document.visibilityState === "visible" && this.isOnline() && Date.now() >= this.photoUrlsExpiresAt - 300000) {
          this.refreshPhotoUrls().catch(error => console.warn("[FACE ARENA signed photo URLs]", error));
        }
      };
      document.addEventListener("visibilitychange", this.photoUrlVisibilityHandler);
    }

    async init() {
      if (!window.supabase?.createClient) {
        this.showFatal("Не удалось загрузить клиент Supabase. Проверьте подключение к сети.");
        return;
      }
      this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      this.mountAuthGate();
      this.client.auth.onAuthStateChange((_event, session) => {
        queueMicrotask(() => this.handleSession(session));
      });
      const { data, error } = await this.client.auth.getSession();
      if (error) this.showMessage(friendlyError(error, "Не удалось проверить вход в аккаунт."));
      await this.handleSession(data.session);
    }

    async handleSession(session) {
      const nextUser = session?.user || null;
      const previousId = this.user?.id || null;
      const nextId = nextUser?.id || null;
      if (previousId !== nextId) {
        // Invalidate the previous account's in-memory snapshot before rendering the next one.
        this.authGeneration++;
        this.stopPhotoUrlRefresh();
        this.photoUrlsExpiresAt = 0;
        this.lastSnapshot = null;
        this.notifications = [];
        window.dispatchEvent(new CustomEvent("face-arena-notifications", { detail: [] }));
        this.initialArenaImagesReadyStarted = false;
        this.serverTimeOffset = 0;
        this.pendingReload = !!this.loading;
        if (this.snapshotReloadTimer) clearTimeout(this.snapshotReloadTimer);
        this.snapshotReloadTimer = null;
        this.stopClockSync();
        this.unsubscribe();
      }
      this.user = nextUser;
      this.ready = !!nextUser;
      if (previousId !== nextId) {
        // Privacy overrides belong to one account only; never carry them across sessions.
        this.privacyOverrides.clear();
        this.dispatch(null);
      }
      this.renderAuthGate();
      if (previousId !== nextId) {
        window.dispatchEvent(new CustomEvent(nextUser ? "face-arena-authenticated-boot-start" : "face-arena-authenticated-boot-stop"));
      }
      if (!nextUser) {
        this.stopPhotoUrlRefresh();
        this.photoUrlsExpiresAt = 0;
        this.stopClockSync();
        this.unsubscribe();
        return;
      }
      await this.loadSnapshot();
      // A slower previous-session request must never start services for a newer account.
      if (this.user?.id !== nextId) return;
      if (this.lastSnapshot?.userId === nextId) this.startPhotoUrlRefresh();
      this.startClockSync();
      this.subscribe();
      await this.refreshNotifications().catch(error => console.warn("[FACE ARENA notifications]", error));
      const coordinator = await this.wakeSafely();
      if (!coordinator.ok) console.warn("[FACE ARENA coordinator unavailable]", coordinator.error);
    }

    getUser() { return this.user; }
    isOnline() { return !!this.client && !!this.user && this.ready; }
    serverNow() { return Date.now() + (Number.isFinite(this.serverTimeOffset) ? this.serverTimeOffset : 0); }
    mapTopArenaRanking(rows, photosById) {
      if (!Array.isArray(rows)) return null;
      return rows.map(row => ({
        name: row.name || "Участник",
        isVerified: !!(row.photo_id && photosById.get(String(row.photo_id))?.isVerified),
        wins: Number(row.wins) || 0,
        losses: Number(row.losses) || 0,
        defenses: Number(row.defenses) || 0,
        streak: Number(row.streak) || 0,
        best: Number(row.best) || 0,
        isChampion: !!row.is_champion,
        isLegendary: !!row.is_legendary,
        laneId: row.lane_id == null ? null : Number(row.lane_id),
        photoId: row.photo_id || null,
        img: row.photo_id ? photosById.get(String(row.photo_id))?.dataUrl || "" : ""
      }));
    }
    async refreshTopArenaRanking() {
      if (!this.isOnline() || !this.lastSnapshot) return false;
      const snapshot = this.lastSnapshot;
      const { data, error } = await this.client.rpc("get_top_arena_ranking");
      if (error) {
        if (this.lastSnapshot === snapshot) this.dispatch({ ...snapshot, topArenaRanking: [] });
        throw error;
      }
      if (this.lastSnapshot !== snapshot || this.user?.id !== snapshot.userId) return false;
      const photosById = new Map((snapshot.photos || []).map(photo => [String(photo.id), photo]));
      this.dispatch({ ...snapshot, topArenaRanking: this.mapTopArenaRanking(data || [], photosById) });
      return true;
    }
    async createPhotoSignedUrlMap(paths, expiresIn = 900) {
      const unique = [...new Set((paths || []).filter(path => typeof path === "string" && path.length))];
      const signed = new Map();
      for (let offset = 0; offset < unique.length; offset += 100) {
        const batch = unique.slice(offset, offset + 100);
        const { data, error } = await this.client.storage.from("arena-photos").createSignedUrls(batch, expiresIn);
        if (error) throw error;
        for (const item of data || []) {
          // A missing/deleted object must not prevent the rest of the arena snapshot
          // from loading. Keep that one image blank and continue with the others.
          if (item.error) {
            console.warn("[FACE ARENA photo unavailable]", item.error);
            continue;
          }
          const resolvedPath = item.path || batch[data.indexOf(item)];
          if (resolvedPath && item.signedUrl) signed.set(resolvedPath, item.signedUrl);
        }
      }
      return signed;
    }
    startPhotoUrlRefresh() {
      if (this.photoUrlRefreshTimer) return;
      this.photoUrlRefreshTimer = setInterval(() => {
        if (this.isOnline() && Date.now() >= this.photoUrlsExpiresAt - 300000) {
          this.refreshPhotoUrls().catch(error => console.warn("[FACE ARENA signed photo URLs]", error));
        }
      }, 300000);
    }
    stopPhotoUrlRefresh() {
      if (this.photoUrlRefreshTimer) clearInterval(this.photoUrlRefreshTimer);
      this.photoUrlRefreshTimer = null;
    }
    async refreshPhotoUrls() {
      if (!this.isOnline() || !this.lastSnapshot || this.photoUrlRefreshInFlight) return false;
      const snapshot = this.lastSnapshot;
      this.photoUrlRefreshInFlight = true;
      try {
        const paths = [
          ...(snapshot.photos || []).filter(photo =>
            photo.objectPath && photo.status !== "removed" &&
            (photo.ownerId === this.user.id || ["matched", "champion", "completed"].includes(photo.status))
          ).map(photo => photo.objectPath),
          // Refresh other users' public-profile avatars as well as arena photos.
          ...(snapshot.profiles || []).map(profile => profile.avatar_path),
          snapshot.profile?.avatarPath
        ].filter(Boolean);
        const [signed, rankingResult] = await Promise.all([
          this.createPhotoSignedUrlMap(paths, 900),
          this.client.rpc("get_top_arena_ranking")
        ]);
        if (rankingResult.error) throw rankingResult.error;
        if (this.lastSnapshot !== snapshot || this.user?.id !== snapshot.userId) return false;
        const photos = (snapshot.photos || []).map(photo => ({
          ...photo,
          dataUrl: photo.objectPath && photo.status !== "removed" ? signed.get(photo.objectPath) || "" : ""
        }));
        const profile = { ...snapshot.profile, avatarUrl: snapshot.profile?.avatarPath ? signed.get(snapshot.profile.avatarPath) || "" : "" };
        const byId = new Map(photos.map(photo => [String(photo.id), photo]));
        const imageFor = (photoId, fallback) => {
          if (photoId == null) return fallback || "";
          const photo = byId.get(String(photoId));
          return photo ? photo.dataUrl : "";
        };
        const arenaBattles = (snapshot.arenaBattles || []).map(battle => ({
          ...battle,
          redImg: imageFor(battle.redPhotoId, battle.redImg),
          blueImg: imageFor(battle.bluePhotoId, battle.blueImg),
          championImg: imageFor(battle.championPhotoId, battle.championImg)
        }));
        const arenaResults = (snapshot.arenaResults || []).map(result => {
          const myPhoto = byId.get(String(result.photoId));
          const opponentPhoto = byId.get(String(result.opponentPhotoId));
          return {
            ...result,
            myPhotoPath: myPhoto?.objectPath || result.myPhotoPath || "",
            opponentPhotoPath: opponentPhoto?.objectPath || result.opponentPhotoPath || "",
            myImg: imageFor(result.photoId, result.myImg),
            opponentImg: imageFor(result.opponentPhotoId, result.opponentImg)
          };
        });
        const history = (snapshot.history || []).map(result => {
          const myPhoto = byId.get(String(result.photoId));
          const opponentPhoto = byId.get(String(result.opponentPhotoId));
          return {
            ...result,
            myPhotoPath: myPhoto?.objectPath || result.myPhotoPath || "",
            opponentPhotoPath: opponentPhoto?.objectPath || result.opponentPhotoPath || "",
            myImg: imageFor(result.photoId, result.myImg),
            opponentImg: imageFor(result.opponentPhotoId, result.opponentImg)
          };
        });
        const participantStats = Object.fromEntries(Object.entries(snapshot.participantStats || {}).map(([id, stats]) => [
          id, { ...stats, img: imageFor(stats.photoId, stats.img) }
        ]));
        const topArenaRanking = this.mapTopArenaRanking(rankingResult.data || [], byId);
        this.photoUrlsExpiresAt = Date.now() + 900000;
        this.dispatch({ ...snapshot, profile, photos, arenaBattles, arenaResults, history, participantStats, topArenaRanking });
        window.dispatchEvent(new CustomEvent("face-arena-photo-urls-refreshed", { detail: { urls: Object.fromEntries(signed) } }));
        return true;
      } catch (error) {
        console.warn("[FACE ARENA signed photo URL refresh]", error);
        await this.loadSnapshot();
        const current = this.lastSnapshot;
        const urls = Object.fromEntries((current?.photos || []).filter(photo => photo.objectPath && photo.dataUrl).map(photo => [photo.objectPath, photo.dataUrl]));
        window.dispatchEvent(new CustomEvent("face-arena-photo-urls-refreshed", { detail: { urls } }));
        return false;
      } finally {
        this.photoUrlRefreshInFlight = false;
      }
    }
    async fetchAllRows(makeQuery, pageSize = 500) {
      const rows = [];
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await makeQuery().range(from, from + pageSize - 1);
        if (error) throw error;
        const page = data || [];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      return { data: rows, error: null };
    }
    async syncServerClock() {
      if (!this.client || !this.user) return false;
      const startedAt = Date.now();
      const { data, error } = await this.client.rpc("get_arena_server_time");
      const finishedAt = Date.now();
      if (error) throw error;
      const serverTimeMs = Number(data);
      if (!Number.isFinite(serverTimeMs)) throw new Error("Supabase returned an invalid server clock");
      this.serverTimeOffset = serverTimeMs - ((startedAt + finishedAt) / 2);
      return true;
    }
    startClockSync() {
      if (this.clockSyncTimer) return;
      this.clockSyncTimer = setInterval(() => {
        this.syncServerClock().catch(error => console.warn("[FACE ARENA server clock]", error));
      }, 30000);
    }
    stopClockSync() {
      if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
      this.clockSyncTimer = null;
    }
    getUser() { return this.user; }

    mountAuthGate() {
      if (document.getElementById("fa-auth-gate")) return;
      const style = document.createElement("style");
      style.textContent = `
        #fa-auth-gate{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(5,5,5,.96);backdrop-filter:blur(18px)}
        #fa-auth-gate.on{display:flex}
        #fa-auth-card{width:min(100%,420px);padding:26px 22px;background:#101010;border:1px solid #262626;border-radius:20px}
        #fa-auth-card .fa-logo{font:800 13px Unbounded,Arial,sans-serif;letter-spacing:.1em;line-height:1.55;margin-bottom:28px}#fa-auth-card .fa-logo-mark{display:inline-block;letter-spacing:.12em}
        #fa-auth-card h2{font:800 23px Unbounded,Arial,sans-serif;margin:0 0 8px}
        #fa-auth-card p{color:#999;font-size:13px;margin:0 0 18px}
        #fa-auth-card input{display:block;width:100%;margin:10px 0;padding:14px 13px;border-radius:10px;border:1px solid #303030;background:#080808;color:#fff;font:600 14px Manrope,Arial,sans-serif;outline:none}
        #fa-auth-card input:focus{border-color:#3478ff}
        #fa-auth-card button{width:100%;padding:13px;border:0;border-radius:10px;background:#fff;color:#050505;font:800 12px Unbounded,Arial,sans-serif;margin-top:9px;cursor:pointer}
        #fa-auth-card button.secondary{background:#171717;color:#fff;border:1px solid #303030}
        #fa-auth-card button:disabled{opacity:.45}
        #fa-auth-error{min-height:20px;color:#ff5a5a;font-size:12px;margin-top:10px}
        #fa-auth-toggle{display:block;text-align:center;color:#aaa;background:none!important;border:0!important;font:600 12px Manrope,Arial,sans-serif!important}
        #fa-auth-name{display:none}
      `;
      document.head.appendChild(style);
      const gate = document.createElement("div");
      gate.id = "fa-auth-gate";
      gate.innerHTML = `
        <div id="fa-auth-card">
          <div class="fa-logo">FACE ARENA<br><span class="fa-logo-mark">(<span style="color:#ff3434">F</span><span style="color:#3478ff">A</span>)</span></div>
          <h2 id="fa-auth-title">Войти в арену</h2>
          <p id="fa-auth-desc">Войдите, чтобы участвовать в общих битвах и сохранять результаты на всех устройствах.</p>
          <input id="fa-auth-name" autocomplete="nickname" maxlength="32" placeholder="Ваше имя">
          <input id="fa-auth-email" type="email" autocomplete="email" placeholder="Email">
          <input id="fa-auth-password" type="password" autocomplete="current-password" placeholder="Пароль (от 8 символов)">
          <button id="fa-auth-submit">Войти</button>
          <button id="fa-auth-toggle" class="secondary">Создать аккаунт</button>
          <div id="fa-auth-error" role="status" aria-live="polite"></div>
        </div>`;
      document.body.appendChild(gate);
      this.authMode = "signin";
      document.getElementById("fa-auth-toggle").onclick = () => {
        this.authMode = this.authMode === "signin" ? "signup" : "signin";
        this.renderAuthGate();
      };
      document.getElementById("fa-auth-submit").onclick = () => this.submitAuth();
      gate.addEventListener("keydown", e => {
        if (e.key === "Enter") this.submitAuth();
      });
    }

    renderAuthGate() {
      const gate = document.getElementById("fa-auth-gate");
      if (!gate) return;
      gate.classList.toggle("on", !this.user);
      const signup = this.authMode === "signup";
      document.getElementById("fa-auth-title").textContent = signup ? "Создать аккаунт" : "Войти в арену";
      document.getElementById("fa-auth-desc").textContent = signup
        ? "Аккаунт нужен для очереди, голосования и сохранения истории."
        : "Войдите, чтобы участвовать в общих битвах и сохранять результаты на всех устройствах.";
      document.getElementById("fa-auth-name").style.display = signup ? "block" : "none";
      document.getElementById("fa-auth-password").autocomplete = signup ? "new-password" : "current-password";
      document.getElementById("fa-auth-submit").textContent = signup ? "Зарегистрироваться" : "Войти";
      document.getElementById("fa-auth-toggle").textContent = signup ? "Уже есть аккаунт? Войти" : "Создать аккаунт";
      document.getElementById("fa-auth-error").textContent = "";
    }

    async submitAuth() {
      const email = document.getElementById("fa-auth-email").value.trim();
      const password = document.getElementById("fa-auth-password").value;
      const name = document.getElementById("fa-auth-name").value.trim().slice(0, 32);
      const button = document.getElementById("fa-auth-submit");
      const errorEl = document.getElementById("fa-auth-error");
      if (!email || !password) { errorEl.textContent = "Введите email и пароль."; return; }
      if (this.authMode === "signup" && password.length < 8) { errorEl.textContent = "Пароль должен содержать минимум 8 символов."; return; }
      if (this.authMode === "signup" && !name) { errorEl.textContent = "Укажите имя."; return; }
      button.disabled = true;
      errorEl.textContent = "";
      try {
        const result = this.authMode === "signup"
          ? await this.client.auth.signUp({ email, password, options: { data: { display_name: name } } })
          : await this.client.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        if (this.authMode === "signup" && !result.data.session) {
          errorEl.textContent = "Supabase всё ещё требует подтверждение email. Нужно отключить Confirm email в настройках Auth.";
        }
      } catch (error) {
        errorEl.textContent = friendlyError(error, "Не удалось выполнить вход. Проверьте данные и попробуйте снова.");
      } finally {
        button.disabled = false;
      }
    }

    showFatal(message) {
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;z-index:100000;background:#050505;color:#fff;display:grid;place-items:center;padding:24px;text-align:center;font:600 14px Manrope,Arial";
      el.textContent = message;
      document.body.appendChild(el);
    }

    showMessage(message) {
      const el = document.getElementById("fa-auth-error");
      if (el) el.textContent = message;
    }

    dispatch(snapshot) {
      this.lastSnapshot = snapshot;
      window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    }

    scheduleSnapshotReload() {
      if (this.snapshotReloadTimer) clearTimeout(this.snapshotReloadTimer);
      this.snapshotReloadTimer = setTimeout(() => {
        this.snapshotReloadTimer = null;
        this.loadSnapshot();
      }, 250);
    }

    async preloadCriticalImages(snapshot) {
      // Only images in cards intersecting the initial viewport are critical.
      // All other battle images remain lazy and load naturally as the user scrolls.
      const candidates = Array.from(document.querySelectorAll("#av .grid .card .duel img"));
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 700;
      const images = candidates.filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < viewportHeight && rect.bottom > 0;
      });
      const total = images.length;
      const emit = (loaded, failed, status) => {
        const progress = total ? 0.18 + 0.78 * ((loaded + failed) / total) : 0.96;
        window.dispatchEvent(new CustomEvent("face-arena-loader-progress", {
          detail: { progress, loaded, failed, total, status }
        }));
      };
      emit(0, 0, total ? "Загружаем фотографии первого экрана" : "Арена готова");
      if (!total) return;

      let loaded = 0, failed = 0;
      const waitForImage = image => new Promise(resolve => {
        let settled = false, timeoutId;
        const finish = async ok => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          image.removeEventListener("load", onLoad);
          image.removeEventListener("error", onError);
          if (ok && typeof image.decode === "function") {
            let decodeTimeout;
            try {
              await Promise.race([
                image.decode(),
                new Promise(done => { decodeTimeout = setTimeout(done, 900); })
              ]);
            } catch (_) {}
            if (decodeTimeout) clearTimeout(decodeTimeout);
          }
          if (ok) loaded++; else failed++;
          emit(loaded, failed, "Фотографии " + (loaded + failed) + "/" + total);
          resolve();
        };
        const onLoad = () => finish(image.naturalWidth > 0);
        const onError = () => finish(false);
        image.loading = "eager";
        image.setAttribute("fetchpriority", "high");
        image.decoding = "async";
        image.addEventListener("load", onLoad, { once: true });
        image.addEventListener("error", onError, { once: true });
        if (image.complete) {
          finish(image.naturalWidth > 0);
          return;
        }
        timeoutId = setTimeout(() => finish(false), 7500);
      });

      // Never hold the app behind off-screen images or a stalled image request.
      await Promise.race([
        Promise.all(images.map(waitForImage)),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]);
      emit(loaded, failed, failed
        ? "Арена готова · фото недоступно: " + failed
        : "Первый экран готов");
    }

    async loadSnapshot() {
      if (!this.isOnline()) return this.lastSnapshot;
      if (this.loading) { this.pendingReload = true; return this.lastSnapshot; }
      this.loading = true;
      window.dispatchEvent(new CustomEvent("face-arena-loader-progress", {
        detail: { progress: 0.08, status: "Загружаем арену" }
      }));
      const requestUserId = this.user.id;
      const requestGeneration = this.authGeneration;
      try {
        const c = this.client;
        let settingsRes = await c.from("arena_user_settings").select("profile_public,history_public,security_notifications,battle_notifications,updated_at").eq("user_id", requestUserId).maybeSingle();
        if (settingsRes.error) throw settingsRes.error;
        if (!settingsRes.data) {
          settingsRes = await c.from("arena_user_settings").insert({ user_id: requestUserId }).select("profile_public,history_public,security_notifications,battle_notifications,updated_at").single();
          if (settingsRes.error) throw settingsRes.error;
        }
        const clockSync = this.syncServerClock().catch(error => {
          console.warn("[FACE ARENA server clock]", error);
          return false;
        });
        const topRankingPromise = c.rpc("get_top_arena_ranking").then(({ data, error }) => {
          if (error) throw error;
          return data || [];
        }).catch(error => {
          console.warn("[FACE ARENA TOP ARENA ranking]", error);
          return [];
        });
        const [photoRes, profileRes, laneRes, battleRes, resultRes, topRankingRows] = await Promise.all([
          this.fetchAllRows(() => c.from("arena_photos").select("id,owner_id,object_path,status,created_at").order("created_at", { ascending: true }).order("id", { ascending: true })),
          this.fetchAllRows(() => c.from("arena_profiles").select("user_id,display_name,handle,is_verified,avatar_path").order("user_id", { ascending: true })),
          c.from("arena_lanes").select("lane_id,champion_photo_id,challenger_photo_id").order("lane_id"),
          c.from("arena_battles").select("id,lane_id,opening,stage,started_at,confirm_until,stage_ends_at,finished_at").in("stage", ["waiting","voting"]),
          this.fetchAllRows(() => c.from("arena_results").select("id,battle_id,lane_id,left_photo_id,right_photo_id,winner_photo_id,is_draw,left_votes,right_votes,total_votes,opening,no_contest,completed_at,is_hidden").order("completed_at", { ascending: false }).order("id", { ascending: false })),
          topRankingPromise
        ]);
        await clockSync;
        for (const r of [photoRes,profileRes,laneRes,battleRes,resultRes]) if (r.error) throw r.error;

        const activeBattleIds = battleRes.data.map(b => b.id);
        const [participantRes, voteRes] = activeBattleIds.length ? await Promise.all([
          this.fetchAllRows(() => c.from("arena_battle_participants").select("battle_id,photo_id,owner_id,side").in("battle_id", activeBattleIds).order("battle_id").order("photo_id")),
          this.fetchAllRows(() => c.from("arena_votes").select("battle_id,voter_id,target_photo_id,comment,created_at").in("battle_id", activeBattleIds).order("battle_id").order("voter_id"))
        ]) : [{ data: [] }, { data: [] }];

        const profiles = new Map(profileRes.data.map(x => [x.user_id, x]));
        const photoRows = photoRes.data;
        const visiblePhotoRows = photoRows.filter(p => p.status !== "removed");
        // Queue rows are needed for global FIFO positions, but their images stay private
        // until the photo enters an active battle. Owners can always see their own queue.
        const signedPhotoRows = visiblePhotoRows.filter(p =>
          p.owner_id === requestUserId || ["matched", "champion", "completed"].includes(p.status)
        );
        // Reuse still-valid signed URLs for unchanged photo objects. A Realtime
        // event often refreshes battle metadata only; minting new URLs here would
        // change every <img src> and force the browser to fetch the same photos again.
        const previousExpiry = this.photoUrlsExpiresAt;
        const canReusePreviousUrls = previousExpiry > Date.now() + 60000;
        const previousUrls = new Map();
        if (canReusePreviousUrls) {
          for (const photo of this.lastSnapshot?.photos || []) {
            if (photo.objectPath && photo.dataUrl && photo.status !== "removed") {
              previousUrls.set(photo.objectPath, photo.dataUrl);
            }
          }
        }
        const signedPhotoUrls = new Map(previousUrls);
        const avatarPaths = profileRes.data.map(p => p.avatar_path).filter(Boolean);
        const pathsToSign = [...signedPhotoRows.map(p => p.object_path), ...avatarPaths]
          .filter(path => path && !signedPhotoUrls.has(path));
        if (pathsToSign.length) {
          const freshUrls = await this.createPhotoSignedUrlMap(pathsToSign, 900);
          for (const [path, url] of freshUrls) signedPhotoUrls.set(path, url);
        }
        const reusedAnyUrl = signedPhotoRows.some(p => previousUrls.has(p.object_path)) ||
          avatarPaths.some(path => previousUrls.has(path));
        this.photoUrlsExpiresAt = reusedAnyUrl
          ? Math.min(previousExpiry, Date.now() + 900000)
          : Date.now() + 900000;
        const photosById = new Map(photoRows.map(p => [p.id, {
          ...p, isVerified: !!profiles.get(p.owner_id)?.is_verified, dataUrl: signedPhotoUrls.get(p.object_path) || ""
        }]));
        const topArenaRanking = this.mapTopArenaRanking(topRankingRows, photosById);
        const photos = visiblePhotoRows.map(p => {
          const profile = profiles.get(p.owner_id) || {};
          return {
            id: p.id, ownerId: p.owner_id, userId: p.owner_id, name: profile.display_name || "Участник",
            handle: profile.handle || "", isVerified: !!profile.is_verified, dataUrl: photosById.get(p.id)?.dataUrl || "",
            objectPath: p.object_path, status: p.status, queuedAt: Date.parse(p.created_at)
          };
        });
        const photoMap = new Map(photos.map(p => [p.id,p]));
        const participantsByBattle = new Map();
        for (const p of participantRes.data) {
          if (!participantsByBattle.has(p.battle_id)) participantsByBattle.set(p.battle_id, []);
          participantsByBattle.get(p.battle_id).push(p);
        }
        const votesByBattle = new Map();
        const battleById = new Map(battleRes.data.map(b => [b.id,b]));
        for (const member of participantRes.data) {
          const battle = battleById.get(member.battle_id);
          const photo = photoMap.get(member.photo_id);
          if (battle && photo && member.owner_id === this.user.id) {
            photo.battleId = battle.lane_id;
            photo.battleUid = battle.id;
            photo.confirmUntil = battle.confirm_until ? Date.parse(battle.confirm_until) : 0;
            photo.side = member.side === "left" ? "R" : "B";
          }
        }
        for (const v of voteRes.data) {
          if (!votesByBattle.has(v.battle_id)) votesByBattle.set(v.battle_id, []);
          votesByBattle.get(v.battle_id).push(v);
        }
        const activeByLane = new Map(battleRes.data.map(b => [b.lane_id,b]));
        const arenaBattles = laneRes.data.map(lane => {
          const battle = activeByLane.get(lane.lane_id);
          const members = battle ? (participantsByBattle.get(battle.id) || []).sort((a,b) => a.side.localeCompare(b.side)) : [];
          const left = members.find(x => x.side === "left");
          const right = members.find(x => x.side === "right");
          const leftPhoto = left ? photoMap.get(left.photo_id) : null;
          const rightPhoto = right ? photoMap.get(right.photo_id) : null;
          const votes = battle ? (votesByBattle.get(battle.id) || []) : [];
          const redVotes = left ? votes.filter(v => v.target_photo_id === left.photo_id).length : 0;
          const blueVotes = right ? votes.filter(v => v.target_photo_id === right.photo_id).length : 0;
          // Ignore stale lane pointers when the referenced photo is absent or removed.
          const champ = lane.champion_photo_id ? photoMap.get(lane.champion_photo_id) : null;
          const validChampionPhotoId = champ ? lane.champion_photo_id : null;
          const me = members.find(x => x.owner_id === this.user.id);
          const confirming = !!battle && battle.stage === "waiting" && battle.confirm_until && Date.parse(battle.confirm_until) > this.serverNow();
          const stage = !battle ? "empty" : (confirming ? "m" : battle.stage === "waiting" ? "w" : "v");
          return {
            id: lane.lane_id, laneId: lane.lane_id, battleUid: battle?.id || null, opening: !!battle?.opening,
            stage, stageEnd: battle ? (confirming ? Date.parse(battle.confirm_until) : Date.parse(battle.stage_ends_at)) : 0,
            confirmUntil: battle?.confirm_until ? Date.parse(battle.confirm_until) : 0,
            stageStarted: battle ? Date.parse(battle.started_at) : 0, totalStage: 70,
            redVotes, blueVotes,
            redName: leftPhoto?.name || "—", blueName: rightPhoto?.name || "—",
            redImg: leftPhoto?.dataUrl || "", blueImg: rightPhoto?.dataUrl || "",
            redPhotoId: leftPhoto?.id || null, bluePhotoId: rightPhoto?.id || null,
            userPhotoId: me?.photo_id || null, isParticipant: !!me, userSide: me?.side === "left" ? "R" : me?.side === "right" ? "B" : null,
            championPhotoId: battle?.opening ? null : validChampionPhotoId,
            championSide: !battle ? (champ ? "R" : null) : !battle.opening && champ ? (leftPhoto?.id === champ.id ? "R" : rightPhoto?.id === champ.id ? "B" : null) : null,
            championName: !battle?.opening && champ ? champ.name || null : null,
            championImg: !battle?.opening && champ ? champ.dataUrl || null : null,
            championStatus: !battle?.opening && validChampionPhotoId ? (resultRes.data.some(result => !result.opening && !result.no_contest && result.winner_photo_id === validChampionPhotoId) ? "confirmed" : "initial") : null,
            championStreak: 0, isMock: false, hasChampionWaiting: !battle && !!champ
          };
        });

        const visibleResultRows = resultRes.data.filter(result => !result.is_hidden);
        const arenaResults = visibleResultRows.map(result => {
          const leftPhoto = photosById.get(result.left_photo_id);
          const rightPhoto = photosById.get(result.right_photo_id);
          const leftProfile = profiles.get(leftPhoto?.owner_id) || {};
          const rightProfile = profiles.get(rightPhoto?.owner_id) || {};
          return {
            resultId: result.id, photoId: result.left_photo_id, battleId: result.lane_id,
            battleUid: result.battle_id, laneId: result.lane_id,
            result: result.no_contest ? "no-contest" : result.is_draw ? "draw" : result.winner_photo_id === result.left_photo_id ? "red" : "blue",
            myVotes: result.left_votes, oppVotes: result.right_votes,
            myImg: leftPhoto?.dataUrl || "",
            opponentImg: rightPhoto?.dataUrl || "",
            myPhotoPath: leftPhoto?.object_path || "",
            opponentPhotoPath: rightPhoto?.object_path || "",
            opponentPhotoId: result.right_photo_id,
            myName: leftProfile.display_name || "Участник",
            opponentName: rightProfile.display_name || "Участник",
            completedAt: Date.parse(result.completed_at), side: "RED"
          };
        });
        const history = [];
        for (const result of visibleResultRows) {
          const leftPhoto = photosById.get(result.left_photo_id);
          const rightPhoto = photosById.get(result.right_photo_id);
          const myPhoto = leftPhoto?.owner_id === this.user.id ? leftPhoto : rightPhoto?.owner_id === this.user.id ? rightPhoto : null;
          if (!myPhoto) continue;
          const opponent = myPhoto.id === result.left_photo_id ? rightPhoto : leftPhoto;
          const myVotes = myPhoto.id === result.left_photo_id ? result.left_votes : result.right_votes;
          const oppVotes = myPhoto.id === result.left_photo_id ? result.right_votes : result.left_votes;
          history.push({
            resultId: result.id, photoId: myPhoto.id, battleId: result.lane_id, battleUid: result.battle_id,
            laneId: result.lane_id, result: result.no_contest ? "no-contest" : result.is_draw ? "draw" : result.winner_photo_id === myPhoto.id ? "win" : "lose",
            myVotes, oppVotes, myName: profiles.get(myPhoto.owner_id)?.display_name || "Вы",
            myImg: myPhoto.dataUrl || "",
            opponentImg: opponent?.dataUrl || "",
            myPhotoPath: myPhoto.object_path || "",
            opponentPhotoPath: opponent?.object_path || "",
            opponentPhotoId: opponent?.id || null,
            opponentName: profiles.get(opponent?.owner_id)?.display_name || "Участник", completedAt: Date.parse(result.completed_at)
          });
        }

        const VOTED = new Set(voteRes.data.filter(v => v.voter_id === this.user.id).map(v => v.battle_id));
        const MY = {};
        for (const [battleId, votes] of votesByBattle) {
          MY[battleId] = votes.map(v => {
            const member = (participantsByBattle.get(battleId) || []).find(p => p.photo_id === v.target_photo_id);
            return { s: member?.side === "left" ? "R" : "B", v: v.comment, author: profiles.get(v.voter_id)?.display_name || "Участник" };
          });
        }
        // Lifetime standings and consecutive-win streaks belong to accounts, not photos.
        const participantStats = {};
        const getStats = (ownerId, photoId = null) => {
          if (!ownerId) return null;
          if (!participantStats[ownerId]) {
            const row = photoId ? photosById.get(photoId) : null;
            const p = profiles.get(ownerId) || {};
            participantStats[ownerId] = {
              wins: 0, losses: 0, defenses: 0, currentStreak: 0, bestStreak: 0,
              topArenaQualified: false, isLegendary: false,
              name: p.display_name || "Участник", ownerId,
              img: row?.dataUrl || "", photoId: row?.id || null,
              isChampion: false, laneId: null
            };
          }
          const stats = participantStats[ownerId];
          if (!stats.img && photoId) {
            const row = photosById.get(photoId);
            if (row) { stats.img = row.dataUrl || ""; stats.photoId = row.id; }
          }
          return stats;
        };
        const chronologicalResults = [...resultRes.data].sort((a,b) =>
          Date.parse(a.completed_at) - Date.parse(b.completed_at) || String(a.id).localeCompare(String(b.id))
        );
        for (const result of chronologicalResults) {
          // Opening battles are setup matches: keep them in history, but never
          // count them toward account wins, losses, streaks, or TOP ARENA.
          if (result.opening || result.no_contest) continue;
          const leftOwner = photosById.get(result.left_photo_id)?.owner_id;
          const rightOwner = photosById.get(result.right_photo_id)?.owner_id;
          const leftStats = getStats(leftOwner, result.left_photo_id);
          const rightStats = getStats(rightOwner, result.right_photo_id);
          if (!leftStats || !rightStats) continue;
          if (result.winner_photo_id === result.left_photo_id) {
            leftStats.wins++;
            leftStats.currentStreak++;
            leftStats.bestStreak = Math.max(leftStats.bestStreak, leftStats.currentStreak);
            leftStats.topArenaQualified ||= leftStats.bestStreak >= 5;
            // In regular battles the left side is the incumbent champion, so only its win is a defense.
            leftStats.defenses++;
            rightStats.losses++;
            rightStats.currentStreak = 0;
          } else if (result.winner_photo_id === result.right_photo_id) {
            rightStats.wins++;
            rightStats.currentStreak++;
            rightStats.bestStreak = Math.max(rightStats.bestStreak, rightStats.currentStreak);
            rightStats.topArenaQualified ||= rightStats.bestStreak >= 5;
            // A challenger victory transfers the title; it is not a successful defense.
            leftStats.losses++;
            leftStats.currentStreak = 0;
          } else {
            // A draw interrupts the win streak without adding a loss.
            leftStats.currentStreak = 0;
            rightStats.currentStreak = 0;
          }
        }
        for (const stats of Object.values(participantStats)) {
          stats.topArenaQualified ||= stats.bestStreak >= 5;
          stats.isLegendary = stats.currentStreak >= 10;
        }
        for (const lane of laneRes.data) {
          // During an opening battle champion_photo_id temporarily stores the first
          // entrant; it is not a title holder until the opening battle is completed.
          const activeBattle = activeByLane.get(lane.lane_id);
          if (activeBattle?.opening) continue;
          if (lane.champion_photo_id) {
            const ownerId = photosById.get(lane.champion_photo_id)?.owner_id;
            const championStats = getStats(ownerId, lane.champion_photo_id);
            if (championStats) {
              championStats.isChampion = true;
              championStats.laneId = lane.lane_id;
            }
          }
        }
        const myProfile = profiles.get(this.user.id) || {};
        if (this.user?.id !== requestUserId || this.authGeneration !== requestGeneration) return null;
        // Keep a just-committed local privacy value if this snapshot read began
        // before Supabase returned the updated row; newer remote rows win.
        const snapshotSettings = { ...settingsRes.data };
        for (const key of ["profile_public","history_public","security_notifications","battle_notifications"]) {
          const local = this.privacyOverrides.get(key);
          if (!local) continue;
          const serverUpdatedAt = Date.parse(snapshotSettings.updated_at || 0) || 0;
          const localUpdatedAt = Date.parse(local.updatedAt || 0) || 0;
          if (serverUpdatedAt <= localUpdatedAt) snapshotSettings[key] = local.value;
          else this.privacyOverrides.delete(key);
        }
        const snapshot = {
          userId: requestUserId,
          photos, arenaBattles, history, arenaResults, VOTED, MY, profiles: profileRes.data,
          profile: { name: myProfile.display_name || this.user.user_metadata?.display_name || "Участник", handle: myProfile.handle || "user", isVerified: !!myProfile.is_verified, role: this.user.app_metadata?.role || "user", avatarPath: myProfile.avatar_path || null, avatarUrl: myProfile.avatar_path ? signedPhotoUrls.get(myProfile.avatar_path) || "" : "" },
          settings: snapshotSettings,
          participantStats,
          topArenaRanking
        };
        if (this.user?.id !== requestUserId || this.authGeneration !== requestGeneration) return null;
        // Render the battle cards immediately underneath the boot screen, then keep
        // the screen covered until their actual images have loaded or timed out.
        this.dispatch(snapshot);
        window.dispatchEvent(new CustomEvent("face-arena-loader-progress", {
          detail: { progress: 0.18, status: "Баттлы получены · загружаем фотографии" }
        }));
        if (!this.initialArenaImagesReadyStarted) {
          this.initialArenaImagesReadyStarted = true;
          this.preloadCriticalImages(snapshot).catch(error => console.warn("[FACE ARENA image preload]", error))
            .finally(() => window.dispatchEvent(new CustomEvent("face-arena-critical-images-ready")));
        }
        return snapshot;
      } catch (error) {
        console.error("[FACE ARENA sync]", error);
        this.showMessage(friendlyError(error, "Не удалось загрузить данные арены. Попробуйте обновить страницу."));
        window.dispatchEvent(new CustomEvent("face-arena-sync-failed"));
        return null;
      } finally {
        this.loading = false;
        if (this.pendingReload) {
          this.pendingReload = false;
          queueMicrotask(() => this.loadSnapshot());
        }
      }
    }

    subscribe() {
      if (!this.isOnline()) return;
      if (!this.channel) {
        this.channel = this.client.channel("face-arena-live")
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_photos" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_lanes" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_battles" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_battle_participants" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_votes" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_results" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_profiles" }, () => this.scheduleSnapshotReload())
          .on("postgres_changes", { event: "*", schema: "public", table: "arena_notifications", filter: "user_id=eq." + this.user.id }, () => {
            this.refreshNotifications().catch(error => console.warn("[FACE ARENA notifications realtime]", error));
          })
          .subscribe();
      }
      if (!this.visibilityChannel) {
        this.visibilityChannel = this.client.channel("arena-visibility-events", { config: { private: true } })
          .on("broadcast", { event: "visibility_changed" }, () => this.scheduleSnapshotReload())
          .subscribe(status => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              console.warn("[FACE ARENA visibility realtime]", status);
            }
          });
      }
    }

    unsubscribe() {
      if (this.channel) this.client.removeChannel(this.channel);
      if (this.visibilityChannel) this.client.removeChannel(this.visibilityChannel);
      this.channel = null;
      this.visibilityChannel = null;
    }

    async wake() {
      const { data } = await this.client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Сессия истекла. Войдите снова.");
      const response = await fetch(WORKER_URL + "/wake", {
        method: "POST",
        headers: { Authorization: "Bearer " + token }
      });
      if (!response.ok) {
        console.warn("[FACE ARENA coordinator] server returned", response.status); throw new Error("Сервер арены временно недоступен. Попробуйте позже.");
      }
      return await response.json();
    }

    async wakeSafely() {
      try {
        await this.wake();
        return { ok: true, error: null };
      } catch (error) {
        console.warn("[FACE ARENA coordinator]", error);
        return { ok: false, error };
      }
    }

    async uploadPhoto(file) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      if (!file) throw new Error("Не выбран файл фотографии.");
      if (!["image/jpeg","image/png","image/webp"].includes(file.type)) throw new Error("Поддерживаются JPEG, PNG и WebP.");
      if (file.size > 5 * 1024 * 1024) throw new Error("Размер фотографии не должен превышать 5 МБ.");

      const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error("Сеанс завершён. Войдите в аккаунт снова.");

      const form = new FormData();
      form.append("file", file, file.name || "battle-photo");
      const response = await fetch(`${SUPABASE_URL}/functions/v1/moderate-arena-photo`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: SUPABASE_KEY
        },
        body: form
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.message || result?.error || "Не удалось проверить фотографию. Попробуйте ещё раз.");
      }
      if (result?.decision === "review") {
        return { moderation: "review", coordinatorAvailable: null, coordinatorError: null };
      }
      if (result?.decision !== "allow" || !result?.photo_id || !result?.object_path) {
        throw new Error("Сервис не подтвердил загрузку фотографии. Попробуйте ещё раз.");
      }

      const path = result.object_path;
      let publicUrl = "";
      try {
        publicUrl = (await this.createPhotoSignedUrlMap([path], 900)).get(path) || "";
      } catch (error) {
        console.warn("[FACE ARENA uploaded photo URL]", error);
      }
      const current = this.lastSnapshot || {};
      const optimisticPhoto = {
        id: result.photo_id, ownerId: this.user.id, userId: this.user.id,
        name: current.profile?.name || "Вы", handle: current.profile?.handle || "",
        dataUrl: publicUrl, objectPath: path, status: "queued", queuedAt: Date.now()
      };
      this.dispatch({
        ...current,
        photos: [...(current.photos || []).filter(photo => String(photo.id) !== String(result.photo_id)), optimisticPhoto]
      });
      this.loadSnapshot();
      this.wakeSafely().then(coordinator => {
        if (!coordinator.ok) console.warn("[FACE ARENA coordinator wake after upload]", coordinator.error);
        this.loadSnapshot();
      });
      return { photoId: result.photo_id, coordinatorAvailable: null, coordinatorError: null };
    }

    async registerVisit(battleId) {
      const { error } = await this.client.rpc("register_arena_visit",{p_battle_id:battleId});
      if (error) throw error;
      const coordinator = await this.wakeSafely();
      await this.loadSnapshot();
      return coordinator;
    }

    async cancelMatch(battleId) {
      const { error } = await this.client.rpc("cancel_arena_match",{p_battle_id:battleId});
      if (error) throw error;
      const coordinator = await this.wakeSafely();
      await this.loadSnapshot();
      return coordinator;
    }

    async submitVote(battleId,targetPhotoId,comment) {
      const { error } = await this.client.rpc("submit_arena_vote",{
        p_battle_id:battleId,p_target_photo_id:targetPhotoId,p_comment:comment
      });
      if (error) throw error;
      const coordinator = await this.wakeSafely();
      await this.loadSnapshot();
      return coordinator;
    }

    async deletePhoto(photoId) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const snapshot = this.lastSnapshot;
      const photo = snapshot?.photos?.find(p => String(p.id) === String(photoId));
      const { error } = await this.client.rpc("delete_arena_photo",{p_photo_id:photoId});
      if (error) throw error;

      // The database has marked this photo as removed and released its slot.
      // Reflect that confirmed server result immediately instead of waiting for
      // the coordinator/worker round-trip before enabling the next upload.
      if (snapshot && this.lastSnapshot === snapshot) {
        this.dispatch({
          ...snapshot,
          photos: (snapshot.photos || []).filter(p => String(p.id) !== String(photoId))
        });
      }

      if (photo?.objectPath && ["queued", "completed"].includes(photo.status)) {
        const { error: storageError } = await this.client.storage.from("arena-photos").remove([photo.objectPath]);
        if (storageError) console.warn("[FACE ARENA storage cleanup]", storageError);
      }

      // Reconcile against Supabase first. Coordinator wake is independent of
      // slot release and must never hold the user's next upload hostage.
      await this.loadSnapshot();
      this.wakeSafely().then(result => {
        if (!result.ok) console.warn("[FACE ARENA coordinator wake after delete]", result.error);
        this.loadSnapshot();
      });
      return { ok: true };
    }

    async uploadProfileAvatar(file) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      if (!file) throw new Error("Не выбран файл фотографии.");
      if (!["image/jpeg","image/png","image/webp"].includes(file.type)) throw new Error("Поддерживаются JPEG, PNG и WebP.");
      if (file.size > 5 * 1024 * 1024) throw new Error("Размер фотографии не должен превышать 5 МБ.");
      const ext = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
      const path = this.user.id + "/profile/avatar-" + crypto.randomUUID() + "." + ext;
      const upload = await this.client.storage.from("arena-photos").upload(path,file,{contentType:file.type,upsert:false,cacheControl:"60"});
      if (upload.error) throw upload.error;
      const oldPath = this.lastSnapshot?.profile?.avatarPath || null;
      const { error } = await this.client.from("arena_profiles").update({ avatar_path:path, updated_at:new Date().toISOString() }).eq("user_id",this.user.id);
      if (error) {
        await this.client.storage.from("arena-photos").remove([path]);
        throw error;
      }
      let avatarUrl = "";
      try {
        avatarUrl = (await this.createPhotoSignedUrlMap([path],900)).get(path) || "";
        // Some Storage API responses omit the path field for a successful signed URL.
        // Fall back to the single-object API so the newly uploaded avatar is not left blank.
        if (!avatarUrl) {
          const signed = await this.client.storage.from("arena-photos").createSignedUrl(path,900);
          if (signed.error) throw signed.error;
          avatarUrl = signed.data?.signedUrl || "";
        }
        if (!avatarUrl) throw new Error("Supabase не вернул ссылку на фотографию");
      } catch (error) {
        console.error("[FACE ARENA avatar URL]",error);
        throw new Error("Фото сохранено, но ссылка на него не создана. Повторите загрузку.");
      }
      const current = this.lastSnapshot || {};
      this.dispatch({ ...current, profile:{ ...current.profile, avatarPath:path, avatarUrl } });
      if (oldPath && oldPath !== path) {
        const { error: removeError } = await this.client.storage.from("arena-photos").remove([oldPath]);
        if (removeError) console.warn("[FACE ARENA old avatar cleanup]",removeError);
      }
      await this.loadSnapshot();
      return true;
    }

    async updateProfile(name,handle) {
      const { error } = await this.client.from("arena_profiles").update({
        display_name:name,handle:handle,updated_at:new Date().toISOString()
      }).eq("user_id",this.user.id);
      if (error?.code === "23505") throw new Error("Этот никнейм уже занят. Выберите другой.");
      if (error) throw error;
      await this.loadSnapshot();
    }

    async getPushStatus() {
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!supported) return { supported: false, subscribed: false, permission: "unsupported" };
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      return { supported: true, subscribed: !!subscription, permission: Notification.permission };
    }

    async enablePush() {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Этот браузер не поддерживает Push-уведомления.");
      }
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
      if (isIOS && !isStandalone) {
        throw new Error("На iPhone сначала добавьте FACE ARENA на экран «Домой» и откройте приложение с его значка.");
      }

      // Request permission immediately in the click call stack (required by Safari/iOS).
      const permissionPromise = Notification.requestPermission();
      const permission = await permissionPromise;
      if (permission !== "granted") throw new Error("Разрешите уведомления FACE ARENA в настройках браузера.");

      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const publicKey = "BL3_H65oUHsO9eE_ECzysuk7_B_vaTFVZvbqvCp06lHy31A6MfMQdQ1SPHet9aJnCYPBhKAMc4JBHehF3Mt2XDc";
        const padding = "=".repeat((4 - publicKey.length % 4) % 4);
        const raw = atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
        const applicationServerKey = Uint8Array.from(raw, char => char.charCodeAt(0));
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }

      const serialized = subscription.toJSON();
      const keys = serialized.keys || {};
      if (!serialized.endpoint || !keys.p256dh || !keys.auth) {
        throw new Error("Браузер вернул неполную Push-подписку. Попробуйте ещё раз.");
      }
      const { error } = await this.client.rpc("save_arena_push_subscription", {
        p_endpoint: serialized.endpoint,
        p_p256dh: keys.p256dh,
        p_auth: keys.auth,
        p_expiration_time: serialized.expirationTime || null,
        p_user_agent: navigator.userAgent.slice(0, 500),
      });
      if (error) {
        await subscription.unsubscribe().catch(() => {});
        throw error;
      }
      return true;
    }

    async disablePush() {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) return true;
      const { error } = await this.client.from("arena_push_subscriptions")
        .delete()
        .eq("user_id", this.user.id)
        .eq("endpoint", subscription.endpoint);
      if (error) throw error;
      await subscription.unsubscribe();
      return true;
    }

    async refreshNotifications() {
      if (!this.isOnline()) return [];
      const userId = this.user.id;
      const { data, error } = await this.client.from("arena_notifications")
        .select("id,kind,title,body,payload,created_at,read_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(50);
      if (error) throw error;
      if (this.user?.id !== userId) return [];
      this.notifications = Array.isArray(data) ? data : [];
      window.dispatchEvent(new CustomEvent("face-arena-notifications", { detail: this.notifications }));
      return this.notifications;
    }

    async markNotificationRead(notificationId) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const userId = this.user.id;
      const { error } = await this.client.from("arena_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", notificationId)
        .eq("user_id", userId)
        .is("read_at", null);
      if (error) throw error;
      return this.refreshNotifications();
    }

    async markAllNotificationsRead() {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const userId = this.user.id;
      const { error } = await this.client.from("arena_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", userId)
        .is("read_at", null);
      if (error) throw error;
      return this.refreshNotifications();
    }

    async updatePrivacySettings(patch) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const userId = this.user.id;
      const allowed = ["profile_public","history_public","security_notifications","battle_notifications"];
      const update = {};
      for (const key of allowed) {
        if (typeof patch?.[key] === "boolean") {
          update[key] = patch[key];
        }
      }
      if (!Object.keys(update).length) return;
      update.updated_at = new Date().toISOString();
      // Record the intended value before the network round-trip so concurrent
      // snapshots cannot repaint the toggle with an older server value.
      for (const key of allowed) {
        if (typeof update[key] === "boolean") this.privacyOverrides.set(key, { value: update[key], updatedAt: update.updated_at });
      }
      const { data, error } = await this.client.from("arena_user_settings")
        .upsert({ user_id: userId, ...update }, { onConflict: "user_id" })
        .select("profile_public,history_public,security_notifications,battle_notifications,updated_at")
        .single();
      if (error || !data) {
        for (const key of allowed) {
          const current = this.privacyOverrides.get(key);
          if (current?.updatedAt === update.updated_at) this.privacyOverrides.delete(key);
        }
        throw error || new Error("Сервер не подтвердил сохранение настроек.");
      }
      for (const key of allowed) {
        if (typeof update[key] === "boolean" && data[key] !== update[key]) {
          const current = this.privacyOverrides.get(key);
          if (current?.updatedAt === update.updated_at) this.privacyOverrides.delete(key);
          throw new Error("Сервер сохранил не все настройки приватности.");
        }
      }
      // Update only the settings snapshot. A full arena reload here made toggles
      // wait for unrelated photos, battles, votes and history queries.
      if (this.user?.id === userId && this.lastSnapshot?.userId === userId) {
        this.dispatch({ ...this.lastSnapshot, settings: { ...(this.lastSnapshot.settings || {}), ...data } });
      }
      if (typeof update.profile_public === "boolean") {
        this.refreshTopArenaRanking().catch(error => console.warn("[FACE ARENA TOP ARENA privacy refresh]", error));
      }
    }

    async getPublicProfile(userId) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Некорректный профиль.");
      const { data, error } = await this.client.rpc("get_public_arena_profile", { p_user_id: userId });
      if (error) throw error;
      return data || null;
    }

    async getPhotoSignedUrls(objectPaths) {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      return this.createPhotoSignedUrlMap(objectPaths, 900);
    }

    async listSessions() {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const { data, error } = await this.client.rpc("get_my_auth_sessions");
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    }

    async revokeOtherSessions() {
      if (!this.isOnline()) throw new Error("Сначала войдите в аккаунт.");
      const { error } = await this.client.auth.signOut({ scope: "others" });
      if (error) throw error;
      return true;
    }

    async signOut() {
      await this.client.auth.signOut();
    }
  }

  const sync = new FaceArenaSync();
  window.FaceArenaSync = sync;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => sync.init(), { once: true });
  else sync.init();
})();