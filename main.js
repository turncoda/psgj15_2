"use strict";

async function main() {
  let promises = [];

  let img_spritesheet = new Image();
  img_spritesheet.src = "assets/spritesheet.png";
  promises.push(new Promise(resolve => {
    img_spritesheet.onload = function() {
      resolve();
    };
  }));

  promises.push(
    fetch("assets/map.ldtk")
    .then(response => response.json())
  );

  let assets = await Promise.all(promises);

  let ldtk_map = assets[1];

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

  let source = document.querySelector("#vs").innerHTML.trim();
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, source);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(vs));
    return;
  }

  source = document.querySelector("#fs").innerHTML.trim();
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, source);
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
  let u_tex = gl.getUniformLocation(program, "tex");
  let u_texSize = gl.getUniformLocation(program, "texSize");
  let u_screenSize = gl.getUniformLocation(program, "screenSize");
  let u_srcRect = gl.getUniformLocation(program, "srcRect");
  let u_dstRect = gl.getUniformLocation(program, "dstRect");

  {
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    let buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0.0, 0.0, 0.0, 0.0,
      1.0, 0.0, 1.0, 0.0,
      1.0, 1.0, 1.0, 1.0,
      0.0, 1.0, 0.0, 1.0,
    ]), gl.STATIC_DRAW);

    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  }

  gl.clearColor(0.5, 0.5, 0.5, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.uniform1i(u_tex, 0);
  gl.uniform2f(u_texSize, 128, 64);
  gl.uniform2f(u_screenSize, 320, 180);

  for (const level of ldtk_map.levels) {
    level.layerInstances.reverse();
    for (const layer of level.layerInstances) {
      for (const tile of layer.gridTiles) {
        gl.uniform4f(u_srcRect,
          tile.src[0], tile.src[1], layer.__cWid, layer.__cHei);
        gl.uniform4f(u_dstRect,
          tile.px[0] + layer.__pxTotalOffsetX, tile.px[1] + layer.__pxTotalOffsetY, layer.__cWid, layer.__cHei);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }
      console.log(layer.__identifier);
    }
  }

}

window.addEventListener("load", main);

