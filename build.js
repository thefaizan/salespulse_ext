const fs = require('fs');
const path = require('path');
const { minify: terserMinify } = require('terser');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { minify: htmlMinify } = require('html-minifier-terser');
const CleanCSS = require('clean-css');

const SOURCE_DIR = __dirname;
const BUILD_DIR = path.join(__dirname, 'production_build');

// Obfuscator options for maximum protection while keeping functionality
const obfuscatorOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.7,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false,
    disableConsoleOutput: false, // Keep console for debugging in production if needed
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false, // Don't rename globals to avoid breaking Chrome API calls
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.75,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false
};

// HTML minifier options
const htmlMinifyOptions = {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true,
    minifyCSS: true,
    minifyJS: true
};

// Clean CSS options
const cleanCSSOptions = {
    level: {
        1: {
            specialComments: 0
        },
        2: {
            mergeMedia: true,
            removeEmpty: true,
            removeDuplicateFontRules: true,
            removeDuplicateMediaBlocks: true,
            removeDuplicateRules: true
        }
    }
};

// Ensure directory exists
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Copy file
function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${path.relative(SOURCE_DIR, src)}`);
}

// Process JavaScript file
async function processJS(src, dest) {
    const code = fs.readFileSync(src, 'utf8');

    try {
        // First minify with terser
        const minified = await terserMinify(code, {
            compress: {
                drop_console: false, // Keep console statements
                drop_debugger: true,
                passes: 2
            },
            mangle: true,
            format: {
                comments: false
            }
        });

        if (minified.error) {
            throw minified.error;
        }

        // Then obfuscate
        const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, obfuscatorOptions);

        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, obfuscated.getObfuscatedCode());
        console.log(`Processed JS: ${path.relative(SOURCE_DIR, src)}`);
    } catch (error) {
        console.error(`Error processing ${src}:`, error.message);
        // Fallback: just copy the original file
        copyFile(src, dest);
    }
}

// Process CSS file
function processCSS(src, dest) {
    const code = fs.readFileSync(src, 'utf8');

    try {
        const minified = new CleanCSS(cleanCSSOptions).minify(code);

        if (minified.errors.length > 0) {
            throw new Error(minified.errors.join(', '));
        }

        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, minified.styles);
        console.log(`Processed CSS: ${path.relative(SOURCE_DIR, src)}`);
    } catch (error) {
        console.error(`Error processing ${src}:`, error.message);
        copyFile(src, dest);
    }
}

// Process HTML file
async function processHTML(src, dest) {
    const code = fs.readFileSync(src, 'utf8');

    try {
        const minified = await htmlMinify(code, htmlMinifyOptions);

        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, minified);
        console.log(`Processed HTML: ${path.relative(SOURCE_DIR, src)}`);
    } catch (error) {
        console.error(`Error processing ${src}:`, error.message);
        copyFile(src, dest);
    }
}

// Copy directory recursively (for icons)
function copyDir(src, dest) {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            // Only copy image files from icons directory
            if (entry.name.endsWith('.png') || entry.name.endsWith('.svg')) {
                copyFile(srcPath, destPath);
            }
        }
    }
}

// Main build function
async function build() {
    console.log('Starting production build...\n');

    // Clean build directory
    if (fs.existsSync(BUILD_DIR)) {
        fs.rmSync(BUILD_DIR, { recursive: true });
        console.log('Cleaned previous build.\n');
    }

    ensureDir(BUILD_DIR);

    // Copy manifest.json
    copyFile(
        path.join(SOURCE_DIR, 'manifest.json'),
        path.join(BUILD_DIR, 'manifest.json')
    );

    // Copy icons
    console.log('\nCopying icons...');
    copyDir(
        path.join(SOURCE_DIR, 'icons'),
        path.join(BUILD_DIR, 'icons')
    );

    // Process JavaScript files
    console.log('\nProcessing JavaScript files...');
    await processJS(
        path.join(SOURCE_DIR, 'background', 'background.js'),
        path.join(BUILD_DIR, 'background', 'background.js')
    );
    await processJS(
        path.join(SOURCE_DIR, 'content', 'content.js'),
        path.join(BUILD_DIR, 'content', 'content.js')
    );
    await processJS(
        path.join(SOURCE_DIR, 'popup', 'popup.js'),
        path.join(BUILD_DIR, 'popup', 'popup.js')
    );

    // Process CSS files
    console.log('\nProcessing CSS files...');
    processCSS(
        path.join(SOURCE_DIR, 'content', 'content.css'),
        path.join(BUILD_DIR, 'content', 'content.css')
    );
    processCSS(
        path.join(SOURCE_DIR, 'popup', 'popup.css'),
        path.join(BUILD_DIR, 'popup', 'popup.css')
    );

    // Process HTML files
    console.log('\nProcessing HTML files...');
    await processHTML(
        path.join(SOURCE_DIR, 'popup', 'popup.html'),
        path.join(BUILD_DIR, 'popup', 'popup.html')
    );

    console.log('\n========================================');
    console.log('Production build completed successfully!');
    console.log(`Output directory: ${BUILD_DIR}`);
    console.log('========================================\n');
}

// Run build
build().catch(error => {
    console.error('Build failed:', error);
    process.exit(1);
});
