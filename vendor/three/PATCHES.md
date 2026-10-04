# Local patches to three.js r185.1

`three.webgpu.min.js`

1. `GPUTextureViewDescriptor` defaults `swizzle` to `undefined` instead of `"rgba"`.
   r185 sends `swizzle: "rgba"` on every texture view. Browsers that implement an
   older experimental form of texture-component swizzle reject that string and every
   mip-mapped texture fails to bind (observed on Chromium 141). `"rgba"` is the
   identity swizzle, so omitting the member is equivalent on browsers that support it
   and harmless on browsers that do not (Safari ignores unknown dictionary members).

Re-apply when upgrading three.js:
`sed -i 's/this.arrayLayerCount=void 0,this.swizzle="rgba"}/this.arrayLayerCount=void 0,this.swizzle=void 0}/g' three.webgpu.min.js`
