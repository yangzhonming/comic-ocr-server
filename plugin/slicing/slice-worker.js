"use strict";
importScripts("slice-algorithm.js");

self.addEventListener("message", event => {
  const {id, input} = event.data || {};
  try {
    const result = self.ComicSliceAlgorithm.analyze(input);
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: {name: error.name, message: error.message}});
  }
});

