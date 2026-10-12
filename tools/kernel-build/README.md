# 内核精简构建（Kernel Slimming）

Solid2 用的 `opencascade.js` 是**全量构建**：`opencascade.wasm` 约 **63 MB**（gzip ≈ 14 MB）。
其中本项目只用到约 50 个 OCCT 类。把未用到的模块排除后，wasm 可显著缩小
（典型为原来的 1/3 ~ 1/2，视依赖闭包而定）。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `scan.mjs` | 扫描 `src/` 里所有 `o.Xxx` / `oc().Xxx` / 字符串符号，推导最小头文件集合 |
| `generated-includes.txt` | 需要编入的 OCCT 头文件（相对 `occt/src/`） |
| `generated-includes.py.txt` | 可直接粘贴进 `make.py` 的 `INCLUDES = [...]` |

重新生成：

```sh
node tools/kernel-build/scan.mjs
```

## 执行精简构建（需要 Docker + Linux 容器）

`opencascade.js@1.1.1` 的构建入口是包内的 `make.py`（Python 3.8），它用一份
**硬编码的 `INCLUDES`** 决定编入哪些 OCCT 头文件。精简 = 用上面的清单替换它。

```sh
# 1) 进入 opencascade.js 包目录
cd node_modules/opencascade.js

# 2) 用生成的清单替换 make.py 里的 INCLUDES 列表
#    （把 generated-includes.py.txt 的内容覆盖 make.py 顶部的 INCLUDES=[...]）

# 3) 构建镜像
docker build -t opencascade.js .

# 4) 运行构建（Windows：注意用 %cd% 挂载 build/dist 两个目录）
docker run -it ^
  -v "%cd%\build":"/opencascade/build/" ^
  -v "%cd%\dist":"/opencascade/dist/" ^
  -v "%cd%\emscripten-cache":"/emscripten/upstream/emscripten/cache/" ^
  -v "%cd%\embind":"/opencascade/embind/" ^
  opencascade.js

# 5) 把产物拷回项目依赖
copy dist\opencascade.wasm.wasm  ..\opencascade.js\dist\
copy dist\opencascade.wasm.js   ..\opencascade.js\dist\
```

回到项目根目录后：

```sh
npm run build            # 重新打包（会自动压缩）
```

> ⚠️ 首次构建会下载并编译整个 OCCT（数十分钟，需数 GB 空间）。
> `make.py` 的 `INCLUDES` 还包含若干“基类/接口”头文件（如
> `BRepAlgoAPI_BooleanOperation.hxx`、`BRepBuilderAPI_MakeShape.hxx`），
> 生成清单里已保留必要的顶层头；若链接报缺符号，按报错把对应父类补进列表即可。

## 构建产物对比

| 产物 | 全量 | 精简后（预期） |
| --- | --- | --- |
| `opencascade.wasm` | 63 MB | 视依赖闭包，通常 20 ~ 40 MB |
| gzip 传输 | 13.9 MB | 同步下降 |
| brotli 传输 | ~10 MB | 同步下降 |

## 无需 Docker 的快速优化：预压缩

即使不重建内核，也可用 brotli 预压缩把 **传输体积** 降到约 1/6：

```sh
npm run build            # vite build + 预压缩
# 或单独执行
node tools/precompress.mjs
```

产物：`dist/**/*.{wasm,js,css,svg,html}.br` 与 `.gz`。
部署时让服务器对支持的客户端返回 `Content-Encoding: br` / `gzip`。
（Nginx 示例见 `tools/precompress.mjs` 顶部注释。）
