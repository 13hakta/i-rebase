const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { minify } = require('terser');

async function minifyJS(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file does not exist: ${inputPath}`);
    return;
  }

  const code = fs.readFileSync(inputPath, 'utf8');

  const result = await minify(code, {
    compress: {
      drop_console: true,
      drop_debugger: true,
      unused: true,
      dead_code: true,
      evaluate: true,
      hoist_funs: true,
      if_return: true,
      join_vars: true,
      loops: true,
      properties: true,
      reduce_funcs: true,
      reduce_vars: true,
      sequences: true,
      side_effects: true,
      switches: true,
      typeofs: true,
      conditionals: true,
      comparisons: true,
    },
    mangle: true,
    format: {
      comments: false,
    },
  });

  fs.writeFileSync(outputPath, result.code);
  console.log(`Minified JS: ${inputPath} -> ${outputPath}`);
}

async function minifyCSSFile(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file does not exist: ${inputPath}`);
    return;
  }

  const css = fs.readFileSync(inputPath, 'utf8');

  // For CSS minification, we'll use a simple regex-based approach
  // since cssnano might not be available
  let minifiedCSS = css
    // Remove comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove whitespace around special characters
    .replace(/\s*([{}:;,>+~])\s*/g, '$1')
    // Remove extra whitespace
    .replace(/\s+/g, ' ')
    // Remove whitespace around parentheses
    .replace(/\s*([()])\s*/g, '$1')
    // Trim the result
    .trim();

  fs.writeFileSync(outputPath, minifiedCSS);
  console.log(`Minified CSS: ${inputPath} -> ${outputPath}`);
}

async function isAlreadyMinified(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Simple heuristic: if file name contains 'min.' or if it's already heavily compressed
  const fileName = path.basename(filePath);
  if (fileName.includes('.min.')) {
    return true;
  }

  // Additional check: if the file is already quite compact (high symbol-to-word ratio)
  // this might indicate it's already minified
  const lines = content.split('\n');
  if (lines.length > 0) {
    // Calculate average line length - minified files tend to have longer lines
    const avgLineLength = content.length / lines.length;
    // If there are few lines but they're long, it might be minified
    const wordCount = content.split(/\W+/).filter(Boolean).length;
    const ratio = content.length / Math.max(wordCount, 1);

    // Heuristic: if the character-to-word ratio is high, it might be minified
    return ratio > 10 && avgLineLength > 100;
  }

  return false;
}

function compileWebviewTS() {
  const webviewDir = path.join(__dirname, '..', 'webview');
  const tsconfigPath = path.join(webviewDir, 'tsconfig.json');

  if (!fs.existsSync(tsconfigPath)) {
    console.log('No webview tsconfig.json found, skipping TS compilation');
    return;
  }

  try {
    execSync(`npx tsc -p "${tsconfigPath}"`, { stdio: 'inherit' });
    console.log('Webview TypeScript compiled successfully');
  } catch (err) {
    console.error('Error compiling webview TypeScript:', err.message);
    throw err;
  }
}

async function processMediaFiles() {
  const webviewDir = path.join(__dirname, '..', 'webview');
  const mediaDir = path.join(__dirname, '..', 'media');

  // First compile TypeScript from webview/ to media/
  compileWebviewTS();

  if (!fs.existsSync(mediaDir)) {
    console.log('Media directory does not exist after TS compilation, skipping CSS/JS minification');
    return;
  }

  // Process CSS files from webview/ directory
  if (fs.existsSync(webviewDir)) {
    const files = fs.readdirSync(webviewDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.css') {
        const filePath = path.join(webviewDir, file);
        const minFilePath = path.join(mediaDir, file);
        await minifyCSSFile(filePath, minFilePath);
        console.log(`Created minified version: ${file} -> ${file}`);
      }
    }
  }

  // Minify compiled JS files in media/ directory
  const mediaFiles = fs.readdirSync(mediaDir);
  for (const file of mediaFiles) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.js') {
      const filePath = path.join(mediaDir, file);
      // Minify in-place
      await minifyJS(filePath, filePath);
      console.log(`Minified in-place: ${file}`);
    }
  }
}

async function processExtensionFiles() {
  // Minify all JavaScript files in the out directory
  const extensionDir = path.join(__dirname, '..', 'out');

  if (!fs.existsSync(extensionDir)) {
    console.error(`Out directory does not exist: ${extensionDir}. Make sure to run tsc first.`);
    return;
  }

  const files = fs.readdirSync(extensionDir);

  for (const file of files) {
    const filePath = path.join(extensionDir, file);
    const ext = path.extname(file).toLowerCase();

    // Process only .js files that are not already minified versions
    if (ext === '.js' && !file.includes('.min.')) {
      const minFilePath = path.join(extensionDir, file.replace('.js', '.min.js'));

      await minifyJS(filePath, minFilePath);
      console.log(`Created minified version: ${file} -> ${file.replace('.js', '.min.js')}`);

      // For the out directory, replace the original file with the minified version
      // since internal imports need the original filenames to work correctly
      fs.unlinkSync(filePath);
      fs.renameSync(minFilePath, filePath);
      console.log(`Replaced ${file} with minified version for internal import compatibility`);
    }
  }
}

// Execute minification for all file types
Promise.all([
  processExtensionFiles(),
  processMediaFiles()
])
  .then(() => {
    console.log('All files have been processed and minified');
  })
  .catch(err => {
    console.error('Error during minification:', err);
  });
