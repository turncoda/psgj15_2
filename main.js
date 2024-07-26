"use strict";

async function main() {
  let promises = [];

  let img_spritesheet = new Image();
  img_spritesheet.src = "assets/spritesheet2.png";
  promises.push(new Promise(resolve => {
    img_spritesheet.onload = function() {
      resolve();
    };
  }));

  promises.push(
    fetch("assets/map2.ldtk")
    .then(response => response.json())
  );

  let assets = await Promise.all(promises);

  let ldtk_map = assets[1];
  let ldtk_map_bases = {};
    for (const level of ldtk_map.levels) {
      for (const layer of level.layerInstances) {
        for (const entity of layer.entityInstances) {
          if (entity.__identifier === "Base") {
            ldtk_map_bases[entity.iid] = { x: entity.px[0], y: entity.px[1], w: entity.width, h: entity.height };
          }
        }
      }
    }
  console.log(ldtk_map_bases);

  let canvas = document.querySelector("#canvas");
  let gl = canvas.getContext("webgl2");
  if (!gl) {
    console.error("couldn't obtain webgl2 context");
    return;
  }
  console.log(gl);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    img_spritesheet);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

  let tex_shadow_map = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex_shadow_map);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null);

  // --- FRAMEBUFFER (for render to texture) ---

  let frameBuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frameBuffer);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    tex_shadow_map, 0);

  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  {
    let status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE) {
        console.error(status.toString(16));
        return;
    }
  }

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);


  let vs_tiles = document.querySelector("#vs_tiles").innerHTML.trim();
  let fs_tiles = document.querySelector("#fs_tiles").innerHTML.trim();
  let sprog_tiles = createProgram(gl, vs_tiles, fs_tiles);

  let vs_shadow = document.querySelector("#vs_shadow").innerHTML.trim();
  let fs_shadow = document.querySelector("#fs_shadow").innerHTML.trim();
  let sprog_shadow = createProgram(gl, vs_shadow, fs_shadow);

  let vs_pass = document.querySelector("#vs_pass").innerHTML.trim();
  let fs_pass = document.querySelector("#fs_pass").innerHTML.trim();
  let sprog_pass = createProgram(gl, vs_pass, fs_pass);

  {
    gl.enableVertexAttribArray(0);
    let buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0.0, 0.0,
      1.0, 0.0,
      1.0, 1.0,
      0.0, 1.0,
    ]), gl.STATIC_DRAW);

    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  // --- RENDER ---

  // --- build shadow map ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frameBuffer);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(sprog_shadow);

    let u_tex = gl.getUniformLocation(sprog_shadow, "tex");
    let u_texSize = gl.getUniformLocation(sprog_shadow, "texSize");
    let u_screenSize = gl.getUniformLocation(sprog_shadow, "screenSize");
    let u_srcRect = gl.getUniformLocation(sprog_shadow, "srcRect");
    let u_dstRect = gl.getUniformLocation(sprog_shadow, "dstRect");
    let u_origin = gl.getUniformLocation(sprog_shadow, "origin");

    gl.uniform1i(u_tex, 0);
    gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
    gl.uniform2f(u_screenSize, 320, 180);

    for (const level of ldtk_map.levels) {
      for (const layer of level.layerInstances) {
        for (const entity of layer.entityInstances) {
          const tile = entity.__tile;
          if (!tile) continue;
          if (!entity.fieldInstances) continue;
          if (entity.fieldInstances.length < 1) continue;
          const entityIid = entity.fieldInstances[0].__value.entityIid;
          const base = ldtk_map_bases[entityIid];
          const base_center_x = (2 * base.x + base.w) / 2.0;
          const base_center_y = (2 * base.y + base.h) / 2.0;
          gl.uniform4f(u_srcRect,
            tile.x, tile.y, tile.w, tile.h);
          gl.uniform4f(u_dstRect,
            entity.__worldX, entity.__worldY, tile.w, tile.h);
          gl.uniform2f(u_origin,
            base_center_x, base_center_y);
          gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        }
      }
    }
  }

  // --- main pass ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    gl.clearColor(0.7, 0.7, 0.7, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- render tiles ---
    {
      gl.useProgram(sprog_tiles);

      let u_tex = gl.getUniformLocation(sprog_tiles, "tex");
      let u_texSize = gl.getUniformLocation(sprog_tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(sprog_tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(sprog_tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(sprog_tiles, "dstRect");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, 320, 180);

      for (const level of ldtk_map.levels) {
        for (const layer of level.layerInstances) {
          for (const tile of layer.gridTiles) {
            gl.uniform4f(u_srcRect,
              tile.src[0], tile.src[1], layer.__cWid, layer.__cHei);
            gl.uniform4f(u_dstRect,
              tile.px[0] + layer.__pxTotalOffsetX, tile.px[1] + layer.__pxTotalOffsetY, layer.__cWid, layer.__cHei);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
          }
        }
      }
    }

    // --- render shadow map texture to screen ---
    {
      /*
       * custom blend function for color inversion:
       *
       *   finalColor = (1 - dstColor) * srcColor + (1 - srcAlpha) * dstColor
       *
       * for shadow map texel (1, 1, 1, 1), finalColor => (1 - dstColor)
       * for shadow map texel (0, 0, 0, 0), finalColor => dstColor
      **/
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(
        gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_ALPHA,
        gl.ZERO, gl.ONE);
      gl.useProgram(sprog_pass);
      let u_tex = gl.getUniformLocation(sprog_pass, "tex");
      gl.uniform1i(u_tex, 1);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // --- render entities ---
    {
      gl.useProgram(sprog_tiles);

      let u_tex = gl.getUniformLocation(sprog_tiles, "tex");
      let u_texSize = gl.getUniformLocation(sprog_tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(sprog_tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(sprog_tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(sprog_tiles, "dstRect");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, 320, 180);

      for (const level of ldtk_map.levels) {
        for (const layer of level.layerInstances) {
          for (const entity of layer.entityInstances) {
            const tile = entity.__tile;
            if (!tile) continue;
            gl.uniform4f(u_srcRect,
              tile.x, tile.y, tile.w, tile.h);
            gl.uniform4f(u_dstRect,
              entity.__worldX, entity.__worldY, tile.w, tile.h);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
          }
        }
      }
    }

  }
}

window.addEventListener("load", main);

// --- HELPERS ---

function createProgram(gl, vs_source, fs_source) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vs_source);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(vs));
    return;
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fs_source);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(fs));
    return;
  }

  let program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return;
  }

  return program;
}

