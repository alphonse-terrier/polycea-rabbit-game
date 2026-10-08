(() => {
  "use strict";

  // ---------- Réglages ----------
  const NEUTRAL_ZONE = 0.35;   // |inclinaison| sous laquelle le téléphone est considéré « droit » (~20°)
  const TRIGGER = 0.55;        // inclinaison au-delà de laquelle on valide / passe (~33°)
  const FEEDBACK_MS = 650;     // durée de l'écran « Trouvé ! » / « Passe »
  const STEADY_MS = 600;       // temps à tenir le téléphone droit avant le compte à rebours
  const NO_SENSOR_MS = 1500;   // délai sans capteur avant de lancer quand même (ordinateur)

  // ---------- Éléments ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $("screen-home"),
    ready: $("screen-ready"),
    game: $("screen-game"),
    end: $("screen-end"),
  };
  const el = {
    play: $("btn-play"),
    replay: $("btn-replay"),
    home: $("btn-home"),
    warning: $("sensor-warning"),
    readyText: $("ready-text"),
    countdown: $("countdown"),
    timer: $("timer"),
    scoreLive: $("score-live"),
    word: $("word"),
    feedback: $("feedback"),
    tapOk: $("tap-ok"),
    tapPass: $("tap-pass"),
    finalScore: $("final-score"),
    endSub: $("end-sub"),
    recap: $("recap"),
    rotate: $("rotate"),
  };

  // ---------- État ----------
  let current = "home";
  let duration = 90;
  let deck = [];
  let results = [];
  let currentWord = null;
  let endAt = 0;
  let timerId = null;
  let locked = false;          // pendant l'affichage du feedback
  let needNeutral = true;      // il faut revenir à la verticale avant une nouvelle action
  let tilt = null;             // dernière inclinaison connue (-1 écran vers le sol, +1 vers le plafond)
  let sensorSeen = false;
  let steadySince = 0;
  let readyTimers = [];
  let wakeLock = null;
  let audio = null;
  let lastSecondBeeped = null;

  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  // ---------- Utilitaires ----------
  function show(name) {
    Object.entries(screens).forEach(([k, s]) => s.classList.toggle("active", k === name));
    current = name;
    updateRotateOverlay();
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function nextWord() {
    if (deck.length === 0) {
      deck = shuffle(window.POLYCEA_WORDS);
      // Évite de reproposer immédiatement le même mot après un nouveau mélange
      if (deck.length > 1 && deck[deck.length - 1] === currentWord) deck.unshift(deck.pop());
    }
    return deck.pop();
  }

  function fitWord() {
    // Réduit la police si le mot est trop long pour l'écran
    el.word.style.fontSize = "";
    const maxW = window.innerWidth * 0.94;
    const maxH = window.innerHeight * 0.7;
    let size = parseFloat(getComputedStyle(el.word).fontSize);
    while ((el.word.scrollWidth > maxW || el.word.scrollHeight > maxH) && size > 24) {
      size -= 4;
      el.word.style.fontSize = size + "px";
    }
  }

  function isPortrait() {
    return window.innerHeight > window.innerWidth;
  }

  function updateRotateOverlay() {
    const needLandscape = isTouch && (current === "ready" || current === "game");
    el.rotate.hidden = !(needLandscape && isPortrait());
  }

  // ---------- Audio ----------
  function initAudio() {
    if (audio) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audio = new Ctx();
  }

  function beep(freq, ms, type = "sine", gain = 0.2, when = 0) {
    if (!audio) return;
    const t = audio.currentTime + when;
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
    osc.connect(g).connect(audio.destination);
    osc.start(t);
    osc.stop(t + ms / 1000);
  }

  const sounds = {
    ok() { beep(660, 120, "triangle"); beep(990, 220, "triangle", 0.2, 0.1); },
    pass() { beep(330, 120, "sawtooth", 0.12); beep(220, 220, "sawtooth", 0.12, 0.1); },
    tick() { beep(880, 80, "square", 0.08); },
    go() { beep(1320, 300, "triangle", 0.25); },
    end() { [784, 659, 523, 392].forEach((f, i) => beep(f, 260, "triangle", 0.2, i * 0.18)); },
  };

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  // ---------- Capteurs ----------
  // On calcule la composante verticale de la normale à l'écran : cos(beta) * cos(gamma).
  //   0  -> téléphone vertical (sur le front)
  //  < 0 -> écran tourné vers le sol (on baisse la tête)  => TROUVÉ
  //  > 0 -> écran tourné vers le plafond (on lève la tête) => PASSE
  // Cette valeur ne dépend ni de l'orientation paysage gauche/droite, ni du navigateur.
  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    sensorSeen = true;
    const rad = Math.PI / 180;
    tilt = Math.cos(e.beta * rad) * Math.cos(e.gamma * rad);
    handleTilt();
  }

  function handleTilt() {
    if (tilt == null) return;
    const neutral = Math.abs(tilt) < NEUTRAL_ZONE;

    if (current === "ready") {
      if (neutral) {
        if (!steadySince) steadySince = performance.now();
      } else {
        steadySince = 0;
      }
      return;
    }

    if (current !== "game" || locked) return;
    if (neutral) {
      needNeutral = false;
      return;
    }
    if (needNeutral) return;
    if (tilt < -TRIGGER) answer(true);
    else if (tilt > TRIGGER) answer(false);
  }

  async function requestSensors() {
    // iOS 13+ exige une autorisation explicite, déclenchée par un geste utilisateur.
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        return (await DOE.requestPermission()) === "granted";
      } catch (err) {
        return false;
      }
    }
    return !!DOE;
  }

  // ---------- Plein écran / veille ----------
  function goFullscreen() {
    const root = document.documentElement;
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req || document.fullscreenElement) return Promise.resolve();
    try {
      return Promise.resolve(req.call(root, { navigationUI: "hide" })).catch(() => {});
    } catch (err) {
      return Promise.resolve();
    }
  }

  async function lockLandscape() {
    try {
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape");
    } catch (err) { /* non supporté (iOS, ordinateur) */ }
  }

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (err) { /* ignoré */ }
  }

  // ---------- Déroulé ----------
  async function start() {
    initAudio();
    if (audio && audio.state === "suspended") audio.resume();

    // Appels synchrones dans le geste utilisateur (exigé par iOS / Android)
    const sensorPromise = requestSensors();
    const fsPromise = goFullscreen();

    const granted = await sensorPromise;
    await fsPromise;
    lockLandscape();
    keepAwake();

    if (!granted) {
      el.warning.hidden = false;
      el.warning.textContent =
        "Capteurs de mouvement indisponibles : touchez la droite de l'écran pour valider, la gauche pour passer.";
    }
    window.addEventListener("deviceorientation", onOrientation);
    prepareRound();
  }

  function clearReadyTimers() {
    readyTimers.forEach(clearTimeout);
    readyTimers.forEach(clearInterval);
    readyTimers = [];
  }

  function prepareRound() {
    clearReadyTimers();
    steadySince = 0;
    el.countdown.hidden = true;
    el.readyText.hidden = false;
    el.readyText.innerHTML = isTouch
      ? "Placez le téléphone<br>sur votre front"
      : "Préparez-vous…";
    show("ready");

    const startedAt = performance.now();
    const poll = setInterval(() => {
      if (el.rotate.hidden === false) { steadySince = 0; return; }
      const steady = steadySince && performance.now() - steadySince >= STEADY_MS;
      const noSensor = !sensorSeen && performance.now() - startedAt >= NO_SENSOR_MS;
      if (steady || noSensor) {
        clearInterval(poll);
        countdown();
      }
    }, 100);
    readyTimers.push(poll);
  }

  function countdown() {
    el.readyText.hidden = true;
    el.countdown.hidden = false;
    let n = 3;
    const tick = () => {
      if (n === 0) {
        sounds.go();
        startGame();
        return;
      }
      el.countdown.textContent = n;
      el.countdown.classList.remove("tick");
      void el.countdown.offsetWidth;
      el.countdown.classList.add("tick");
      sounds.tick();
      n--;
      readyTimers.push(setTimeout(tick, 900));
    };
    tick();
  }

  function startGame() {
    results = [];
    locked = false;
    needNeutral = true;
    lastSecondBeeped = null;
    el.scoreLive.textContent = "0";
    screens.game.classList.remove("flash-ok", "flash-pass");
    show("game");
    showWord(nextWord());
    endAt = performance.now() + duration * 1000;
    updateTimer();
    timerId = setInterval(updateTimer, 100);
    handleTilt(); // le téléphone est déjà à la verticale : prêt à jouer
  }

  function showWord(word) {
    currentWord = word;
    el.word.textContent = word;
    fitWord();
  }

  function updateTimer() {
    const remaining = Math.max(0, endAt - performance.now());
    const secs = Math.ceil(remaining / 1000);
    el.timer.textContent = secs;
    el.timer.classList.toggle("urgent", secs <= 10);
    if (secs <= 5 && secs > 0 && secs !== lastSecondBeeped) {
      lastSecondBeeped = secs;
      sounds.tick();
    }
    if (remaining <= 0) endGame();
  }

  function answer(found) {
    if (current !== "game" || locked) return;
    locked = true;
    needNeutral = true;
    results.push({ word: currentWord, found });
    const score = results.filter((r) => r.found).length;
    el.scoreLive.textContent = score;

    screens.game.classList.add(found ? "flash-ok" : "flash-pass");
    el.feedback.textContent = found ? "Trouvé !" : "Passe";
    if (found) { sounds.ok(); vibrate(80); } else { sounds.pass(); vibrate([40, 60, 40]); }

    setTimeout(() => {
      if (current !== "game") return;
      screens.game.classList.remove("flash-ok", "flash-pass");
      showWord(nextWord());
      locked = false;
      handleTilt(); // si le téléphone est déjà revenu à la verticale
    }, FEEDBACK_MS);
  }

  function endGame() {
    clearInterval(timerId);
    timerId = null;
    if (current !== "game") return;
    // Le mot affiché à la fin compte comme passé
    if (currentWord && !locked) results.push({ word: currentWord, found: false });
    sounds.end();
    vibrate([200, 100, 200]);

    const score = results.filter((r) => r.found).length;
    el.finalScore.textContent = score;
    el.endSub.textContent = score > 1 ? "mots trouvés" : "mot trouvé";
    el.recap.innerHTML = "";
    results.forEach((r) => {
      const li = document.createElement("li");
      li.className = r.found ? "ok" : "pass";
      li.textContent = r.word;
      el.recap.appendChild(li);
    });
    show("end");
  }

  function backHome() {
    clearReadyTimers();
    clearInterval(timerId);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    show("home");
  }

  // ---------- Événements ----------
  document.querySelectorAll(".duration").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".duration").forEach((b) => {
        b.classList.toggle("selected", b === btn);
        b.setAttribute("aria-checked", b === btn ? "true" : "false");
      });
      duration = parseInt(btn.dataset.duration, 10);
    });
  });

  el.play.addEventListener("click", start);
  el.replay.addEventListener("click", () => {
    goFullscreen();
    keepAwake();
    prepareRound();
  });
  el.home.addEventListener("click", backHome);

  // Contrôles tactiles de secours, seulement sans capteur
  // (évite les validations accidentelles quand on tient le téléphone sur le front)
  el.tapOk.addEventListener("click", () => { if (!sensorSeen) answer(true); });
  el.tapPass.addEventListener("click", () => { if (!sensorSeen) answer(false); });

  // Clavier (pour tester sur ordinateur)
  window.addEventListener("keydown", (e) => {
    if (current === "game") {
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); answer(true); }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); answer(false); }
    }
    if (e.key === "Escape" && current !== "home") backHome();
  });

  window.addEventListener("resize", () => {
    updateRotateOverlay();
    if (current === "game") fitWord();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && current !== "home") keepAwake();
  });

  document.querySelector(`.duration.selected`).setAttribute("aria-checked", "true");
})();
