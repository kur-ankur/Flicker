// This runs in the Figma plugin environment
try {
  figma.showUI(__html__, { width: 300, height: 144 });
} catch (error) {
  console.error('Error showing UI:', error);
  figma.notify('Error loading plugin interface');
  figma.closePlugin();
}

// Restore saved corner radius
(async () => {
  try {
    const saved = await figma.clientStorage.getAsync('cornerRadius');
    figma.ui.postMessage({
      type: 'init-radius',
      value: typeof saved === 'number' ? saved : 24
    });
  } catch (error) {
    console.error('Error restoring corner radius:', error);
    figma.ui.postMessage({
      type: 'init-radius',
      value: 24
    });
  }
})();

// Track fonts that already triggered an error notification for this run
let notifiedFontFamilies = new Set();

// Listen for messages from the UI
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'create-skeleton') {
      const cornerRadius = msg.cornerRadius !== undefined ? msg.cornerRadius : 24;
      await createSkeletonVersion(cornerRadius);
    }

    if (msg.type === 'save-radius') {
      const value = Number(msg.value);
      if (!isNaN(value) && value >= 0) {
        await figma.clientStorage.setAsync('cornerRadius', value);
      }
    }

    if (msg.type === 'cancel') {
      figma.closePlugin();
    }
  } catch (error) {
    console.error('Error handling message:', error);
    figma.notify('An error occurred: ' + error.message);
  }
};

// Recursively detach all INSTANCE nodes in the tree
async function detachAllInstances(node) {
  if (!node) return;
  // If node is an INSTANCE, detach and recurse into its children
  if (node.type === 'INSTANCE') {
    // Detach and get the resulting group/frame
    const detached = await node.detachInstance();
    // Recursively detach in the new node (could be FRAME or GROUP)
    if (detached && detached.children) {
      // Copy children to array to avoid mutation issues
      const children = Array.from(detached.children);
      for (const child of children) {
        await detachAllInstances(child);
      }
    }
    return; // No need to recurse into the original instance
  }
  // If node has children, recurse into them
  if (node.children) {
    // Copy children to array to avoid mutation issues
    const children = Array.from(node.children);
    for (const child of children) {
      await detachAllInstances(child);
    }
  }
}

async function createSkeletonVersion(cornerRadius = 24) {
  notifiedFontFamilies = new Set(); // Reset on every run
  
  // Validate cornerRadius input
  if (typeof cornerRadius !== 'number' || isNaN(cornerRadius) || cornerRadius < 0) {
    figma.notify("Invalid corner radius. Using default value of 24px.");
    cornerRadius = 24;
  }
  
  const selection = figma.currentPage.selection;

  if (!selection || selection.length === 0) {
    figma.notify("Please select a frame to convert");
    return;
  }

  const processedFrames = [];
  let hasErrors = false;

  try {
    console.log(`🚀 Starting skeleton creation for ${selection.length} selected item(s)`);
    
    // Process each selected item
    for (const selectedNode of selection) {
      // Validate each selection
      if (!selectedNode || (selectedNode.type !== 'FRAME' && selectedNode.type !== 'COMPONENT' && selectedNode.type !== 'INSTANCE')) {
        console.warn(`⚠️ Skipping invalid selection: ${selectedNode && selectedNode.name ? selectedNode.name : 'unnamed'} (${selectedNode && selectedNode.type ? selectedNode.type : 'unknown'})`);
        hasErrors = true;
        continue;
      }

      // Skip locked, invisible, or too-small frames
      if (selectedNode.locked || selectedNode.visible === false || 
          selectedNode.width < 4 || selectedNode.height < 4) {
        console.warn(`⚠️ Skipping frame "${selectedNode.name}": locked, invisible, or too small`);
        continue;
      }

      // Determine if this is a nested frame (parent is also a FRAME)
      const isNestedFrame = selectedNode.parent && selectedNode.parent.type === 'FRAME';
      
      if (isNestedFrame) {
        // NESTED FRAME: Convert in-place without duplication
        console.log(`📦 Processing nested frame in-place: ${selectedNode.name}`);
        await convertFrameInPlace(selectedNode, cornerRadius);
        processedFrames.push(selectedNode);
      } else {
        // TOP-LEVEL FRAME: Use current duplication logic
        console.log(`🖼️ Processing top-level frame with duplication: ${selectedNode.name}`);
        const skeletonFrame = await convertTopLevelFrame(selectedNode, cornerRadius);
        if (skeletonFrame) {
          processedFrames.push(skeletonFrame);
        }
      }
    }

    // Select all processed frames
    if (processedFrames.length > 0) {
      figma.currentPage.selection = processedFrames;
      
      const message = processedFrames.length === 1 
        ? "✨ Skeleton version created successfully!"
        : `✨ ${processedFrames.length} skeleton versions created successfully!`;
      figma.notify(message);
    } else {
      figma.notify("No valid frames were processed. Please select frame(s), component(s), or component instance(s).");
    }

    // Show additional error message if some selections were invalid
    if (hasErrors && processedFrames.length > 0) {
      figma.notify("Some selections were invalid and skipped. Check console for details.", { timeout: 3000 });
    }

  } catch (error) {
    console.error("❌ Error creating skeleton:", error);
    figma.notify("Error creating skeleton: " + error.message);
  }
}

/**
 * Converts a nested frame in-place without duplication or renaming
 * @param {FrameNode} frame - The nested frame to convert
 * @param {number} cornerRadius - The corner radius for skeleton elements
 */
async function convertFrameInPlace(frame, cornerRadius = 24) {
  try {
    console.log(`🔄 Converting nested frame in-place: ${frame.name}`);
    
    // DON'T remove all children - let the conversion process handle it!
    // This was the bug - we were emptying the frame before conversion
    
    // Detach all instances/components within the frame
    await detachAllInstances(frame);
    
    // Convert the frame's content to skeleton (this will convert text to skeleton blocks)
    await convertToSkeleton(frame, cornerRadius);
    
    console.log(`✅ In-place conversion completed for: ${frame.name}`);
    
  } catch (error) {
    console.error(`❌ Error converting frame in-place: ${frame.name}`, error);
    throw error;
  }
}

/**
 * Converts a top-level frame by duplication (original logic)
 * @param {FrameNode} frame - The top-level frame to convert
 * @param {number} cornerRadius - The corner radius for skeleton elements
 * @returns {FrameNode} The created skeleton frame
 */
async function convertTopLevelFrame(frame, cornerRadius = 24) {
  try {
    console.log(`🔄 Converting top-level frame with duplication: ${frame.name}`);
    
    // Clone the selected frame
    const skeletonFrame = frame.clone();
    skeletonFrame.name = frame.name + " (Skeleton)";

    // Position it next to the original
    skeletonFrame.x = frame.x + frame.width + 50;
    skeletonFrame.y = frame.y;
    
    console.log(`📦 Cloned frame positioned at: ${skeletonFrame.x}, ${skeletonFrame.y}`);

    // Detach all instances/components in the clone
    await detachAllInstances(skeletonFrame);

    // Convert all elements to skeleton blocks
    await convertToSkeleton(skeletonFrame, cornerRadius);

    console.log(`✅ Top-level conversion completed for: ${frame.name}`);
    
    return skeletonFrame;
    
  } catch (error) {
    console.error(`❌ Error converting top-level frame: ${frame.name}`, error);
    throw error;
  }
}

async function convertToSkeleton(rootFrame, cornerRadius = 24) {
  console.log("🔄 Converting frame to skeleton:", rootFrame.name);
  
  // Collect all elements that need to be converted
  const elementsToConvert = [];
  
  function collectElements(currentNode, depth = 0) {
    try {
      if (!currentNode) return;
      
      const indent = "  ".repeat(depth);
      const nodeName = currentNode.name || 'unnamed';
      const nodeType = currentNode.type || 'unknown';
      
      console.log(`${indent}📋 Checking node: ${nodeName} (${nodeType})`);
      
      if (shouldConvertToSkeleton(currentNode)) {
        console.log(`${indent}✅ Will convert: ${nodeName}`);
        elementsToConvert.push(currentNode);
      }
      
      // Recursively check children
      if (currentNode.children && Array.isArray(currentNode.children)) {
        for (const child of currentNode.children) {
          if (child) {
            collectElements(child, depth + 1);
          }
        }
      }
    } catch (error) {
      console.error('Error in collectElements:', error);
      // Continue processing other elements
    }
  }
  
  // Start collecting from the root frame
  collectElements(rootFrame);
  
  console.log(`📊 Found ${elementsToConvert.length} elements to convert to skeleton`);
  
  // Convert each element to skeleton (in reverse order to avoid index issues)
  for (let i = elementsToConvert.length - 1; i >= 0; i--) {
    const element = elementsToConvert[i];
    try {
      console.log(`🎨 Converting: ${element.name} at (${element.x}, ${element.y})`);
      await convertElementToSkeleton(element, cornerRadius);
    } catch (error) {
      console.error(`❌ Error converting ${element.name}:`, error);
    }
  }
}



function shouldConvertToSkeleton(node) {
  try {
    if (!node) return false;
    
    // Skip invisible elements
    if (node.visible === false) {
      return false;
    }
    
    // Skip elements that are too small
    if (typeof node.width !== 'number' || typeof node.height !== 'number' || 
        node.width < 4 || node.height < 4) {
      return false;
    }
    
    // Convert these types of elements
    const convertibleTypes = [
      'TEXT',
      'RECTANGLE', 
      'ELLIPSE',
      'VECTOR',
      'POLYGON',
      'STAR',
      'BOOLEAN_OPERATION',
      'LINE'
    ];
    
    return convertibleTypes.includes(node.type);
  } catch (error) {
    console.error('Error in shouldConvertToSkeleton:', error);
    return false;
  }
}

// Enhanced skeleton conversion for TEXT nodes: multi-line support
async function convertElementToSkeleton(originalElement, cornerRadius = 24) {
  console.log(`🔧 Converting ${originalElement.name} (${originalElement.type})`);
  console.log(`📍 Position relative to parent: (${originalElement.x}, ${originalElement.y})`);
  console.log(`📏 Original size: ${originalElement.width} x ${originalElement.height}`);

  const parent = originalElement.parent;
  if (!parent) {
    console.error("❌ Element has no parent, cannot convert");
    return;
  }

  const originalIndex = parent.children.indexOf(originalElement);

  // --- ENHANCED LOGIC FOR TEXT NODES ---
  if (originalElement.type === 'TEXT') {
    // Helper to get font size (handles mixed fonts)
    async function getFontSizeAndLoadFont(textNode) {
      let fontSize = 16; // fallback
      let fontName = textNode.fontName;
      
      try {
        if (typeof fontName === 'object' && fontName.family && fontName.style) {
          // Try to load the font, with fallback to system fonts
          try {
            await figma.loadFontAsync(fontName);
          } catch (fontError) {
            // Try common system fonts as fallback
            const fallbackFonts = [
              { family: "Inter", style: "Regular" },
              { family: "Roboto", style: "Regular" },
              { family: "SF Pro Text", style: "Regular" },
              { family: "Helvetica", style: "Regular" }
            ];
            
            let fontLoaded = false;
            for (const fallback of fallbackFonts) {
              try {
                await figma.loadFontAsync(fallback);
                fontName = fallback;
                fontLoaded = true;
                break;
              } catch (fallbackError) {
                continue;
              }
            }
            
            if (!fontLoaded) {
              throw fontError;
            }
          }
          
          fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 16;
        } else if (typeof textNode.getRangeFontName === 'function') {
          // Mixed fonts: load all unique fonts and get max font size
          const fontNames = new Set();
          let maxFontSize = fontSize;
          
          for (let i = 0; i < textNode.characters.length; i++) {
            const f = textNode.getRangeFontName(i, i + 1);
            if (typeof f === 'object' && f.family && f.style) {
              fontNames.add(JSON.stringify(f));
            }
            if (typeof textNode.getRangeFontSize === 'function') {
              const s = textNode.getRangeFontSize(i, i + 1);
              if (typeof s === 'number' && s > maxFontSize) maxFontSize = s;
            }
          }
          
          for (const fontStr of fontNames) {
            try {
              await figma.loadFontAsync(JSON.parse(fontStr));
            } catch (fontError) {
              console.warn('Could not load font:', fontStr, fontError);
            }
          }
          fontSize = maxFontSize;
        }
        return fontSize;
      } catch (e) {
        // Font could not be loaded - only notify once per font family per run
        const familyName = (fontName && fontName.family) || 'MIXED';
        if (!notifiedFontFamilies.has(familyName)) {
          notifiedFontFamilies.add(familyName);
          figma.notify(
            `⚠️ Unable to load font "${familyName}". Using fallback for skeleton.`,
            { timeout: 2000 }
          );
        }
        throw e;
      }
    }

    // Try to load font and get font size
    let fontSize;
    try {
      fontSize = await getFontSizeAndLoadFont(originalElement);
    } catch (e) {
      // Font load failed, skip this node
      return;
    }

    // Get line height (handle AUTO and MIXED)
    let lineHeightValue = null;
    let lineHeight = originalElement.lineHeight;
    if (lineHeight === undefined || lineHeight === null || lineHeight === 'MIXED') {
      // Fallback: use AUTO
      lineHeightValue = fontSize * 1.2;
    } else if (lineHeight.unit === 'AUTO') {
      lineHeightValue = fontSize * 1.2;
    } else if (lineHeight.unit === 'PIXELS') {
      lineHeightValue = lineHeight.value;
    } else if (lineHeight.unit === 'PERCENT') {
      lineHeightValue = fontSize * (lineHeight.value / 100);
    } else {
      // Unknown, fallback
      lineHeightValue = fontSize * 1.2;
    }

    // Estimate line count
    const lineCount = Math.max(1, Math.round(originalElement.height / lineHeightValue));
    const skeletonHeight = Math.max(6, Math.round(fontSize * 0.7));
    const skeletonRects = [];
    let yCursor = originalElement.y;

    for (let i = 0; i < lineCount; i++) {
      const rect = figma.createRectangle();
      rect.x = originalElement.x;
      rect.y = yCursor;
      // Width: last line is shorter
      if (i === lineCount - 1) {
        rect.resize(originalElement.width * 0.6, skeletonHeight);
      } else {
        rect.resize(originalElement.width, skeletonHeight);
      }
      // Set skeleton fill
      rect.fills = [{
        type: 'SOLID',
        color: { r: 0.85, g: 0.85, b: 0.85 }
      }];
      // Set corner radius
      rect.cornerRadius = cornerRadius;
      // Name for clarity
      rect.name = `${originalElement.name} (skeleton line ${i + 1})`;
      // Insert at correct index (stacked in order)
      parent.insertChild(originalIndex + i, rect);
      skeletonRects.push(rect);
      // Move y cursor for next line
      yCursor += lineHeightValue;
    }

    // Only after all skeleton rects are created, remove the original text node
    originalElement.remove();
    return;
  }

  // --- DEFAULT LOGIC FOR OTHER NODE TYPES ---
  // (Unchanged from before)
  const skeletonRect = figma.createRectangle();
  try {
    skeletonRect.x = originalElement.x;
    console.log(`✅ Set x position: ${skeletonRect.x}`);
  } catch (error) {
    console.error(`❌ Error setting x:`, error);
  }
  try {
    skeletonRect.y = originalElement.y;
    console.log(`✅ Set y position: ${skeletonRect.y}`);
  } catch (error) {
    console.error(`❌ Error setting y:`, error);
  }
  try {
    skeletonRect.resize(originalElement.width, originalElement.height);
    console.log(`✅ Resized to: ${skeletonRect.width} x ${skeletonRect.height} (from original: ${originalElement.width} x ${originalElement.height})`);
  } catch (error) {
    console.error(`❌ Error resizing:`, error);
  }
  try {
    skeletonRect.fills = [{
      type: 'SOLID',
      color: { r: 0.85, g: 0.85, b: 0.85 }
    }];
    console.log(`✅ Set fills`);
  } catch (error) {
    console.error(`❌ Error setting fills:`, error);
  }
  let finalCornerRadius = cornerRadius;
  if (originalElement.type === 'ELLIPSE') {
    finalCornerRadius = Math.min(skeletonRect.width, skeletonRect.height) / 2;
  }
  try {
    skeletonRect.cornerRadius = finalCornerRadius;
    console.log(`✅ Set corner radius: ${finalCornerRadius}px (user selected: ${cornerRadius}px)`);
  } catch (error) {
    console.error(`❌ Error setting corner radius:`, error);
  }
  try {
    skeletonRect.name = originalElement.name + " (skeleton)";
    console.log(`✅ Set name: ${skeletonRect.name}`);
  } catch (error) {
    console.error(`❌ Error setting name:`, error);
  }
  parent.insertChild(originalIndex, skeletonRect);
  originalElement.remove();
}