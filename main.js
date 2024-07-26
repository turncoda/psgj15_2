"use strict";

const ONE_OVER_SQRT_OF_TWO = 1.0 / Math.sqrt(2.0);
const TARGET_FRAME_RATE = 60.0; // frames per second
const TARGET_FRAME_DURATION = 1000.0 / TARGET_FRAME_RATE; // milliseconds

const TILE_SIZE = 16;
const SCREEN_WIDTH = 320;
const SCREEN_HEIGHT = 180;

let gl;
let buffer_unit_rect;
let buffer_debug;

let ldtk_map;
let ldtk_map_bases = {};
let img_spritesheet;
let fb;
let shader_programs = {};
let spritesheet_json;
const entity_data = {};

let prev_timestamp = 0;
let time_since_last_draw = 0;

let player_x, player_y;
let player_sprite_x, player_sprite_y;
let player_speed_x = 1.0;
let player_speed_y = 1.0;
let is_pressed_up = false;
let is_pressed_left = false;
let is_pressed_down = false;
let is_pressed_right = false;

let player_sprite_width;
let player_sprite_height;

class Rect {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
}

class EntityData {
  constructor(tex_rect, base_rect, bounding_polygon) {
    // tex_rect
    // - region of texture
    // - (x, y) of rect is TOP LEFT corner of sprite's bounding box
    this.tex_rect = tex_rect;
    // base_rect
    // - relative to BOTTOM LEFT corner of tex_rect AND base_rect
    // - coordinates are tiles, not pixels
    // - will flip Y when transforming to world position
    this.base_rect = base_rect || new Rect(0, 0, 0, 0);
    // bounding_polygon
    // - format: [x_0, y_0, x_1, y_1, ... x_n, y_n]
    // - coordinates are tiles, not pixels
    // - vertices clockwise around the perimeter of the sprite
    // - (0, 0) is BOTTOM LEFT corner of tex_rect
    // - will flip Y when transforming to world position
    this.bounding_polygon = bounding_polygon || [];
  }

  getBoundingPolygon() {
    let result = [];
    for (let i = 0; i < this.bounding_polygon.length; i += 2) {
      const x = this.bounding_polygon[i];
      const y = this.bounding_polygon[i+1];
      result.push(TILE_SIZE * x);
      result.push(this.tex_rect.h - TILE_SIZE * y);
    }
    return result;
  }

  getBaseRect() {
    const x = TILE_SIZE * this.base_rect.x;
    const y = this.tex_rect.h - TILE_SIZE * (this.base_rect.y + this.base_rect.h);
    const w = TILE_SIZE * this.base_rect.w;
    const h = TILE_SIZE * this.base_rect.h;
    return new Rect(x, y, w, h);
  }
}

window.addEventListener("load", main);

/**
 * keycodes:
 * w 87
 * a 65
 * s 83
 * d 68
 * space 32
 * e 69
 * q 81
 */

document.onkeydown = function (e) {
  switch (e.keyCode) {
    case 87: // w
    is_pressed_up = true;
    break;
    case 65: // a
    is_pressed_left = true;
    break;
    case 83: // s
    is_pressed_down = true;
    break;
    case 68: // d
    is_pressed_right = true;
    break;
  }
};

document.onkeyup = function (e) {
  switch (e.keyCode) {
    case 87: // w
    is_pressed_up = false;
    break;
    case 65: // a
    is_pressed_left = false;
    break;
    case 83: // s
    is_pressed_down = false;
    break;
    case 68: // d
    is_pressed_right = false;
    break;
  }
};

async function main() {
  let promises = [];

  img_spritesheet = new Image();
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

  promises.push(
    fetch("assets/spritesheet2.json")
    .then(response => response.json())
  );

  let assets = await Promise.all(promises);

  ldtk_map = assets[1];
  for (const level of ldtk_map.levels) {
    for (const layer of level.layerInstances) {
      for (const entity of layer.entityInstances) {
        if (entity.__identifier === "Base") {
          ldtk_map_bases[entity.iid] = { x: entity.px[0], y: entity.px[1], w: entity.width, h: entity.height };
        }
        if (entity.__identifier === "PlayerStart") {
          player_x = entity.px[0];
          player_y = entity.px[1];
        }
      }
    }
  }

  spritesheet_json = assets[2];

  for (const tag of spritesheet_json.meta.frameTags) {
    if (tag.name === "player_walk") {
      const frame = spritesheet_json.frames[tag.from].frame;
      player_sprite_x = frame.x;
      player_sprite_y = frame.y;
      player_sprite_width = frame.w;
      player_sprite_height = frame.h;
    }
  }

  // --- INIT WEBGL ---
  let canvas = document.querySelector("#canvas");
  gl = canvas.getContext("webgl2");
  if (!gl) {
    console.error("couldn't obtain webgl2 context");
    return;
  }

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

  // --- SET UP FRAMEBUFFER (for render to texture) ---

  fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
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

  // --- COMPILE SHADERS ---

  let vs_tiles = document.querySelector("#vs_tiles").innerHTML.trim();
  let fs_tiles = document.querySelector("#fs_tiles").innerHTML.trim();
  shader_programs.tiles = createProgram(gl, vs_tiles, fs_tiles);

  let vs_shadow = document.querySelector("#vs_shadow").innerHTML.trim();
  let fs_shadow = document.querySelector("#fs_shadow").innerHTML.trim();
  shader_programs.shadow = createProgram(gl, vs_shadow, fs_shadow);

  let vs_pass = document.querySelector("#vs_pass").innerHTML.trim();
  let fs_pass = document.querySelector("#fs_pass").innerHTML.trim();
  shader_programs.pass = createProgram(gl, vs_pass, fs_pass);

  let vs_debug = document.querySelector("#vs_debug").innerHTML.trim();
  let fs_debug = document.querySelector("#fs_debug").innerHTML.trim();
  shader_programs.debug = createProgram(gl, vs_debug, fs_debug);

  // --- LOAD SPRITE DATA ---

  for (const tag of spritesheet_json.meta.frameTags) {
    if (!tag.name[0].match(/[A-Z]/g)) continue;
    const frame = spritesheet_json.frames[tag.from].frame;
    entity_data[tag.name] = new EntityData(
      new Rect(frame.x, frame.y, frame.w, frame.h));
  }

  entity_data["Clocktower"].base_rect = new Rect(0, 0, 2, 2);
  entity_data["Clocktower"].bounding_polygon = [
    0, 0,
    0, 2,
    2, 4,
    4, 5,
    4, 2,
    2, 0,
  ];

  entity_data["House"].base_rect = new Rect(0, 0, 4, 3);
  entity_data["House"].bounding_polygon = [
    0, 0,
    0, 3,
    2, 5,
    5, 6,
    6, 5,
    6, 2,
    4, 0,
  ];

  entity_data["Well"].base_rect = new Rect(0, 0, 2, 2);
  entity_data["Well"].bounding_polygon = [
    0, 0,
    0, 2,
    1, 3,
    3, 4,
    3, 1,
    2, 0,
  ];

  entity_data["DebugBlock"].base_rect = new Rect(0, 0, 1, 1);
  entity_data["DebugBlock"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  // --- CONSTRUCT GEOMETRY ---

  buffer_unit_rect = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_unit_rect);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]), gl.STATIC_DRAW);

  buffer_debug = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0,
    100, 100,
  ]), gl.STATIC_DRAW);

  for (const entity_name of Object.keys(entity_data)) {
    const data = entity_data[entity_name]
    const vertices = data.getBoundingPolygon();
    data.num_verts = vertices.length / 2;
    data.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, data.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  }

  // --- SET UP VERTEX ARRAYS ---

  gl.enableVertexAttribArray(0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_unit_rect);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.enableVertexAttribArray(1);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  window.requestAnimationFrame(step);
}

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

function step(timestamp) {
  const dt = timestamp - prev_timestamp;
  prev_timestamp = timestamp;
  time_since_last_draw += dt;
  if (time_since_last_draw >= TARGET_FRAME_DURATION) {
    time_since_last_draw %= TARGET_FRAME_DURATION;
    update();
    render();
  }
  window.requestAnimationFrame(step);
}

function update() {
  let dx = 0;
  let dy = 0;
  if (is_pressed_right) {
    dx += player_speed_x;
  }
  if (is_pressed_left) {
    dx -= player_speed_x;
  }
  if (is_pressed_up) {
    dy -= player_speed_y;
  }
  if (is_pressed_down) {
    dy += player_speed_y;
  }

  player_x += dx;
  player_y += dy;
}

function render() {
  // --- build shadow map ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(shader_programs.shadow);

    let u_tex = gl.getUniformLocation(shader_programs.shadow, "tex");
    let u_texSize = gl.getUniformLocation(shader_programs.shadow, "texSize");
    let u_screenSize = gl.getUniformLocation(shader_programs.shadow, "screenSize");
    let u_srcRect = gl.getUniformLocation(shader_programs.shadow, "srcRect");
    let u_dstRect = gl.getUniformLocation(shader_programs.shadow, "dstRect");
    let u_origin = gl.getUniformLocation(shader_programs.shadow, "origin");
    let u_cameraPos = gl.getUniformLocation(shader_programs.shadow, "cameraPos");

    gl.uniform1i(u_tex, 0);
    gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
    gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
    const [cx, cy] = getCameraPosition();
    gl.uniform2f(u_cameraPos, cx, cy);

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
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, cx, cy);

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

      // --- render player ---
      gl.uniform4f(u_srcRect, player_sprite_x, player_sprite_y, 32, 32);
      gl.uniform4f(u_dstRect, Math.trunc(player_x), Math.trunc(player_y), 32, 32);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }

    // --- render shadow map texture to screen ---
    {
      /**
       * custom blend function for color inversion:
       *
       *   finalColor = (1 - dstColor) * srcColor + (1 - srcAlpha) * dstColor
       *
       * for shadow map texel (1, 1, 1, 1), finalColor => (1 - dstColor)
       * for shadow map texel (0, 0, 0, 0), finalColor => dstColor
       */
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(
        gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_ALPHA,
        gl.ZERO, gl.ONE);
      gl.useProgram(shader_programs.pass);
      let u_tex = gl.getUniformLocation(shader_programs.pass, "tex");
      gl.uniform1i(u_tex, 1);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // --- render entities ---
    {
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, cx, cy);

      for (const level of ldtk_map.levels) {
        for (const layer of level.layerInstances) {
          for (const entity of layer.entityInstances) {
            if (!entity.__tags) continue;
            if (!entity.__tags.includes("static")) continue;
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

    // --- render debug collision ---
    {
      gl.useProgram(shader_programs.debug);

      let u_screenSize = gl.getUniformLocation(shader_programs.debug, "screenSize");
      let u_cameraPos = gl.getUniformLocation(shader_programs.debug, "cameraPos");
      let u_worldPos = gl.getUniformLocation(shader_programs.debug, "worldPos");
      let u_debugColor = gl.getUniformLocation(shader_programs.debug, "debugColor");

      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, cx, cy);
      gl.uniform3f(u_debugColor, 1, 0, 0);


      for (const level of ldtk_map.levels) {
        for (const layer of level.layerInstances) {
          for (const entity of layer.entityInstances) {
            const data = entity_data[entity.__identifier];
            if (!data) continue;
            gl.bindBuffer(gl.ARRAY_BUFFER, data.buffer);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
            gl.uniform2f(u_worldPos, entity.__worldX, entity.__worldY);
            gl.drawArrays(gl.LINE_LOOP, 0, data.num_verts);
          }
        }
      }
    }

  }
}

function getCameraPosition() {
  return [
    player_x + 3 * TILE_SIZE - 0.5 * SCREEN_WIDTH,
    player_y - 0.5 * SCREEN_HEIGHT,
  ];
}

