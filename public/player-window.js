const params = new URLSearchParams(window.location.search);
const refs = {
  title: document.querySelector("#title"),
  subtitle: document.querySelector("#subtitle"),
  stage: document.querySelector("#stage"),
  video: document.querySelector("#video"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  closeButton: document.querySelector("#closeButton")
};

let hlsInstance = null;

function cleanupPlayer() {
  if (!hlsInstance) {
    return;
  }

  hlsInstance.destroy();
  hlsInstance = null;
}

function attachPlayback(url, mode) {
  cleanupPlayer();
  refs.video.pause();
  refs.video.removeAttribute("src");
  refs.video.removeAttribute("type");
  refs.video.load();

  const canUseNative = refs.video.canPlayType("application/vnd.apple.mpegurl");

  if (mode === "hls" && window.Hls && window.Hls.isSupported()) {
    hlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(refs.video);
    hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
      refs.video.play().catch(() => {});
    });
    return;
  }

  refs.video.src = url;
  if (mode === "hls" && canUseNative) {
    refs.video.type = "application/vnd.apple.mpegurl";
  }
  refs.video.play().catch(() => {});
}

function init() {
  const title = params.get("title") || "Player Externo";
  const subtitle = params.get("subtitle") || "Criado por Carlos Ramos";
  const url = params.get("url") || "";
  const mode = params.get("mode") || "file";
  const poster = params.get("poster") || "";
  const creator = params.get("creator") || "Carlos Ramos";

  document.title = `${title} | ${creator}`;
  refs.title.textContent = title;
  refs.subtitle.textContent = subtitle;

  if (poster) {
    refs.stage.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.68)), url('${poster}')`;
  }

  if (url) {
    attachPlayback(url, mode);
  }

  refs.video.addEventListener("playing", () => {
    refs.stage.classList.add("playing");
  });

  refs.video.addEventListener("pause", () => {
    if (refs.video.currentTime <= 0) {
      refs.stage.classList.remove("playing");
    }
  });

  refs.fullscreenButton.addEventListener("click", async () => {
    if (!document.fullscreenElement) {
      await refs.video.requestFullscreen().catch(() => {});
      return;
    }

    await document.exitFullscreen().catch(() => {});
  });

  refs.closeButton.addEventListener("click", () => {
    window.close();
  });

  window.addEventListener("beforeunload", cleanupPlayer);
  document.addEventListener("dblclick", async () => {
    if (!document.fullscreenElement) {
      await refs.video.requestFullscreen().catch(() => {});
      return;
    }

    await document.exitFullscreen().catch(() => {});
  });
}

init();
