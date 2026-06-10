/* =======================================================================
 * editor.js — Code editor module (Ace) with HTML / CSS / JS tabs.
 * Exposes a global `Editor` object used by the rest of the app.
 * ===================================================================== */
(function () {
  "use strict";

  const STORAGE_KEY = "codetovideo.project.v1";

  // --- Default starter project (a clean CSS animation that exports nicely) ---
  const DEFAULTS = {
    html:
      '<div class="scene">\n' +
      '  <div class="ring"></div>\n' +
      '  <h1 class="title">Hello, Video</h1>\n' +
      '  <p class="subtitle">Coded in HTML, CSS &amp; JS</p>\n' +
      "</div>\n",
    css:
      "html,body{height:100%;margin:0;}\n" +
      ".scene{\n" +
      "  height:100%; display:flex; flex-direction:column;\n" +
      "  align-items:center; justify-content:center; gap:14px;\n" +
      "  font-family:Inter,Arial,sans-serif; color:#fff;\n" +
      "  background:linear-gradient(120deg,#5b8cff,#7c5cff,#ff5b9c);\n" +
      "  background-size:200% 200%; animation:flow 6s ease-in-out infinite;\n" +
      "}\n" +
      "@keyframes flow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}\n" +
      ".title{font-size:7vw; margin:0; letter-spacing:1px; animation:pop 2.2s ease-in-out infinite;}\n" +
      ".subtitle{font-size:2.4vw; margin:0; opacity:.85;}\n" +
      "@keyframes pop{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}\n" +
      ".ring{\n" +
      "  width:18vw; height:18vw; border-radius:50%;\n" +
      "  border:6px solid rgba(255,255,255,.5); border-top-color:#fff;\n" +
      "  animation:spin 1.4s linear infinite;\n" +
      "}\n" +
      "@keyframes spin{to{transform:rotate(360deg)}}\n",
    js:
      "// Your JavaScript runs inside the preview.\n" +
      "// Tip: for the smoothest exports use requestAnimationFrame\n" +
      "// or the global `frame` / `time` values the recorder provides.\n" +
      "console.log('Preview booted at', new Date().toISOString());\n",
  };

  // --- Example templates the user can load from the dropdown ---
  const TEMPLATES = {
    "css-animation": DEFAULTS,

    "canvas-bars": {
      html: '<canvas id="c"></canvas>',
      css:
        "html,body{margin:0;height:100%;background:#08101f;overflow:hidden}\n" +
        "#c{display:block;width:100%;height:100%}",
      js:
        "const c = document.getElementById('c');\n" +
        "const ctx = c.getContext('2d');\n" +
        "function resize(){ c.width = innerWidth; c.height = innerHeight; }\n" +
        "resize(); addEventListener('resize', resize);\n" +
        "function draw(t){\n" +
        "  const time = t / 1000;\n" +
        "  ctx.fillStyle = '#08101f'; ctx.fillRect(0,0,c.width,c.height);\n" +
        "  const n = 48, bw = c.width / n;\n" +
        "  for (let i=0;i<n;i++){\n" +
        "    const h = (Math.sin(time*3 + i*0.4)*0.5+0.5) * c.height*0.7 + 10;\n" +
        "    const hue = (i/n*300 + time*40) % 360;\n" +
        "    ctx.fillStyle = `hsl(${hue} 90% 60%)`;\n" +
        "    ctx.fillRect(i*bw+2, c.height-h, bw-4, h);\n" +
        "  }\n" +
        "  requestAnimationFrame(draw);\n" +
        "}\n" +
        "requestAnimationFrame(draw);",
    },

    "p5-particles": {
      html:
        "<!-- p5.js is loaded from a CDN in the preview -->\n" +
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/p5.min.js"><\/script>',
      css: "html,body{margin:0;height:100%;background:#000;overflow:hidden}",
      js:
        "let pts = [];\n" +
        "function setup(){ createCanvas(windowWidth, windowHeight); for(let i=0;i<160;i++) pts.push({x:random(width),y:random(height),a:random(TWO_PI)}); noStroke(); }\n" +
        "function windowResized(){ resizeCanvas(windowWidth, windowHeight); }\n" +
        "function draw(){\n" +
        "  background(0,0,0,40);\n" +
        "  const t = frameCount*0.02;\n" +
        "  for(const p of pts){\n" +
        "    p.x += Math.cos(p.a + t)*1.6; p.y += Math.sin(p.a + t)*1.6;\n" +
        "    if(p.x<0)p.x=width; if(p.x>width)p.x=0; if(p.y<0)p.y=height; if(p.y>height)p.y=0;\n" +
        "    fill((frameCount + p.x)%255, 180, 255);\n" +
        "    circle(p.x, p.y, 4);\n" +
        "  }\n" +
        "}",
    },

    "three-cube": {
      html: '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>',
      css: "html,body{margin:0;height:100%;background:#0b1020;overflow:hidden}canvas{display:block}",
      js:
        "const scene = new THREE.Scene();\n" +
        "const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);\n" +
        "camera.position.z = 3;\n" +
        "const renderer = new THREE.WebGLRenderer({antialias:true});\n" +
        "renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(devicePixelRatio);\n" +
        "document.body.appendChild(renderer.domElement);\n" +
        "const geo = new THREE.BoxGeometry(1.3,1.3,1.3);\n" +
        "const mat = new THREE.MeshStandardMaterial({color:0x5b8cff, metalness:0.4, roughness:0.2});\n" +
        "const cube = new THREE.Mesh(geo, mat); scene.add(cube);\n" +
        "const light = new THREE.DirectionalLight(0xffffff,1.2); light.position.set(3,4,5); scene.add(light);\n" +
        "scene.add(new THREE.AmbientLight(0x7c5cff, 0.6));\n" +
        "addEventListener('resize', ()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });\n" +
        "function animate(){ requestAnimationFrame(animate); cube.rotation.x+=0.01; cube.rotation.y+=0.013; renderer.render(scene,camera); }\n" +
        "animate();",
    },
  };

  const LANG = { html: "html", css: "css", js: "javascript" };
  const editors = {};
  let active = "html";
  let onChangeCb = null;

  function buildEditor(name) {
    const ed = ace.edit("editor-" + name);
    ed.setTheme("ace/theme/tomorrow_night");
    ed.session.setMode("ace/mode/" + LANG[name]);
    ed.setOptions({
      fontSize: "13px",
      showPrintMargin: false,
      useWorker: false, // workers can't load from CDN reliably; disable syntax worker
      enableBasicAutocompletion: true,
      enableLiveAutocompletion: true,
      wrap: true,
      tabSize: 2,
    });
    ed.session.on("change", debounce(() => onChangeCb && onChangeCb(), 350));
    return ed;
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function setActiveTab(name) {
    active = name;
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    document.querySelectorAll(".editor-host").forEach((h) =>
      h.classList.toggle("active", h.id === "editor-" + name)
    );
    if (editors[name]) {
      editors[name].resize();
      editors[name].focus();
    }
  }

  const Editor = {
    init(onChange) {
      onChangeCb = onChange;

      if (typeof ace === "undefined") {
        console.error("Ace failed to load (offline?). Falling back to plain textareas.");
        this._fallback(onChange);
        return;
      }

      ["html", "css", "js"].forEach((n) => (editors[n] = buildEditor(n)));

      const saved = this._load();
      const proj = saved || DEFAULTS;
      editors.html.setValue(proj.html, -1);
      editors.css.setValue(proj.css, -1);
      editors.js.setValue(proj.js, -1);

      // Tab switching
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
      });

      // Template loader
      const tpl = document.getElementById("templateSelect");
      tpl.addEventListener("change", () => {
        const key = tpl.value;
        if (key && TEMPLATES[key]) {
          this.setProject(TEMPLATES[key]);
          onChangeCb && onChangeCb();
        }
        tpl.value = "";
      });

      // Persist on unload
      window.addEventListener("beforeunload", () => this._save());
      setInterval(() => this._save(), 5000);

      setActiveTab("html");
    },

    _fallback(onChange) {
      ["html", "css", "js"].forEach((n) => {
        const host = document.getElementById("editor-" + n);
        host.innerHTML = "";
        const ta = document.createElement("textarea");
        ta.style.cssText =
          "width:100%;height:100%;border:none;resize:none;background:#0d1117;color:#e6edf3;font-family:monospace;font-size:13px;padding:10px;";
        ta.value = DEFAULTS[n];
        ta.addEventListener("input", debounce(onChange, 350));
        host.appendChild(ta);
        editors[n] = {
          getValue: () => ta.value,
          setValue: (v) => (ta.value = v),
          resize() {},
          focus() {},
        };
      });
      document.querySelectorAll(".tab").forEach((tab) =>
        tab.addEventListener("click", () => setActiveTab(tab.dataset.tab))
      );
      setActiveTab("html");
    },

    getProject() {
      return {
        html: editors.html ? editors.html.getValue() : "",
        css: editors.css ? editors.css.getValue() : "",
        js: editors.js ? editors.js.getValue() : "",
      };
    },

    setProject(proj) {
      if (!editors.html) return;
      editors.html.setValue(proj.html || "", -1);
      editors.css.setValue(proj.css || "", -1);
      editors.js.setValue(proj.js || "", -1);
    },

    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.getProject()));
      } catch (e) {
        /* ignore quota / privacy mode */
      }
    },

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
  };

  window.Editor = Editor;
})();
