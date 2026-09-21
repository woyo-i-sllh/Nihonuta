# Nihonuta / 日本歌

可搜索、可查阅的日语歌词资料库。网站收录日文歌词、平假名注音、中文对照与相关歌曲链接。

公开地址：<https://woyo-i-sllh.github.io/Nihonuta/>

## 功能

- 按歌名、歌手、日文歌词、假名注音和中文翻译搜索
- 歌手筛选、日文歌名/歌手排序
- 分片渐进载入全文索引，首屏不等待完整索引
- 歌词详情在新窗口打开，原歌词卡保持原有版式
- 访问过的歌词卡可离线回看
- 页面会定期检查 `site/data/site.json`，资料库有新版本时提示刷新
- 公开 JSON 数据接口，供其他本地工具拉取最新目录

## 目录

```text
Nihonuta/
  site/                         GitHub Pages 静态站点
    index.html                  搜索首页
    lyrics/                     2052 张歌词卡
    data/catalog.json           歌名、歌手、翻译摘要等目录数据
    data/search/                全文搜索分片
    data/site.json              当前版本、数量和更新时间
  tools/build_site.py           从歌词源目录重建站点
  tools/update.ps1              本地更新与发布入口
  .github/workflows/             GitHub Pages 自动部署
```

## 更新流程

歌词源目录保持只读。构建脚本只读取源文件，重新复制到 `site/lyrics` 后生成索引。

```powershell
cd F:\life\songs\public\Nihonuta
powershell -ExecutionPolicy Bypass -File .\tools\update.ps1
```

确认构建结果后提交并推送：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\update.ps1 -Publish
```

如果源目录不是默认位置：

```powershell
.\tools\update.ps1 -Source 'D:\path\to\日语歌' -Publish
```

推送后，GitHub Actions 会将 `site/` 发布到 GitHub Pages。

## 本地预览

```powershell
cd F:\life\songs\public\Nihonuta
python -m http.server 8080 --directory site
```

然后打开 <http://localhost:8080/>。不要直接用 `file://` 打开，因为浏览器会阻止 JSON 索引读取。

## 公开数据接口

- `data/site.json`：站点版本、更新时间、歌曲数和歌手数
- `data/catalog.json`：完整歌曲目录
- `data/search/manifest.json`：全文索引分片清单
- `data/search/*.json`：全文索引分片

`data/site.json` 中的 `version` 可用于判断网页是否发布了新版本。

## 版权说明

本项目只用于个人日语学习与歌词查阅。歌词、翻译及相关内容的权利归原作者和权利方所有，请勿用于商业用途。