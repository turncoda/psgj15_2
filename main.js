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
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img_spritesheet);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

  let vs_tiles = document.querySelector("#vs_tiles").innerHTML.trim();
  let fs_tiles = document.querySelector("#fs_tiles").innerHTML.trim();
  let sprog_tiles = createProgram(gl, vs_tiles, fs_tiles);

  let vs_shadow = document.querySelector("#vs_shadow").innerHTML.trim();
  let fs_shadow = document.querySelector("#fs_shadow").innerHTML.trim();
  let sprog_shadow = createProgram(gl, vs_shadow, fs_shadow);

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

  gl.clearColor(0.5, 0.5, 0.5, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  {
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

