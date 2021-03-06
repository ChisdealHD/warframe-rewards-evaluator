// External Modules
import * as fs from 'fs';
import * as path from 'path';
import * as stringSimilarity from 'string-similarity';
import * as screenshot from 'desktop-screenshot';
import * as Tesseract from 'tesseract.js';
import * as uuid from 'node-uuid';
import * as sharp from 'sharp';
import { Store } from 'redux';

// Internal Modules
import { ApiConnector } from './ApiConnector';

// Actions
import { tesseractProgress } from '../actions/tesseractProgess';
import { getDataStarted } from '../actions/getDataStarted';
import { showStatsWindow } from '../actions/showStatsWindow';

// Models
import { IState } from '../models/state';

export class ScreenEvaluator {

    public static async processCurrentScreen(store: Store<IState>, capturePath: string) {

        //  /————————————————————————————————————————————————————————————————————————————————————————————————————————————————\
        // |   TODO: Ask Warframe for permisson for internal hooks, at the time this is the only legal way to get the info..  |
        //  \————————————————————————————————————————————————————————————————————————————————————————————————————————————————/

        // Let's get to work, show em' something!
        store.dispatch(showStatsWindow());
        store.dispatch(getDataStarted());

        const temporaryScreenshotBaseFileName = '__capture-' + uuid.v4() + '-' + uuid.v4();
        const temporaryScreenshotRawFileName = temporaryScreenshotBaseFileName + '_raw.jpg';
        const temporaryScreenshotCroppedFileName = temporaryScreenshotBaseFileName + 'cropped.jpg';
        let temporaryScreenshotNameRaw = path.join(capturePath, temporaryScreenshotRawFileName);
        const temporaryScreenshotNameCropped = path.join(capturePath, temporaryScreenshotCroppedFileName);

        screenshot(temporaryScreenshotNameRaw, function(error, complete) {
            // HACK we should probably not ignore all errors, but some are wrong..

            // This is pretty experimental.. how is it with other screen sizes? only tested this on 1920x1080
            const leftPercentage = 20;
            const topPercentage = 23;
            const heightPercentage = 6;
            const widthPercentage = 77;

            if (process.env.NODE_ENV  !== 'production') {
                temporaryScreenshotNameRaw =  path.join(__dirname, '..', '..', '..', 'test', '__testimage.jpg');
            }
            else {
                console.log('running in test mode');
            }

            console.log(temporaryScreenshotNameRaw);
            sharp(temporaryScreenshotNameRaw)
            .metadata()
            .then(info => {
                // Scale the image relatively
                const left = Math.round(info.height * leftPercentage / 100);
                const top = Math.round(info.width * topPercentage / 100);
                const width = Math.round(info.width * widthPercentage / 100);
                const height = Math.round(info.height * heightPercentage / 100);

                return sharp(temporaryScreenshotNameRaw)
                // Initial center crop
                .extract({
                    left: left,
                    top: top,
                    width: width,
                    height: height
                })
                .toFile(temporaryScreenshotNameCropped);
            }).then(() => {
                let progressInPercent = 0;

                Tesseract.recognize(temporaryScreenshotNameCropped)
                .progress((progress) => {
                    // TODO leak progress to react stuff
                    if (progress.status === 'recognizing text') {
                        // Throttle down to percentage leaks
                        const currentProgressInPercent = parseInt(progress.progress * 100 as any, 10);
                        if (currentProgressInPercent > progressInPercent) {
                            progressInPercent = currentProgressInPercent;
                            store.dispatch(tesseractProgress(currentProgressInPercent));
                        }
                    }
                })
                .catch(err => console.error(err))
                .then(function(result) {
                    let foundLines: Tesseract.Line[] = [] as Tesseract.Line[] ;
                    result.blocks.forEach(block => {
                        // HACK Typings hack assertion, it's wrong in the src typings
                        (block.paragraphs as any as Tesseract.Paragraph[]).forEach(paragraph => {
                            foundLines = foundLines.concat(paragraph.lines);
                        });
                    });
                    const validityRegex = /[A-Z]{5,}/; // The line needs to contain at least five capital letters to be considered valid
                    let validLines: Tesseract.Line[] = [] as Tesseract.Line[];
                    foundLines.forEach(line => {
                        if (line.text.match(validityRegex)) {
                            validLines.push(line);
                        }
                    });
                    // First word has no previous word, use this instead
                    const wordBaseLineFallback =  {
                        text: null,
                        baseline: {
                            x1: 0
                        }
                    };
                    let builtNames = [];
                    let currentNameIndex = 0;
                    validLines.forEach((line, index) => {
                        line.words.forEach((word, index) => {
                            const previousWord = line.words[index - 1] || wordBaseLineFallback;
                            // If the previous word was not in a 30px range close of this word, complete the current word
                            if (!((previousWord.baseline.x1 + 30) > word.baseline.x0)) {
                                currentNameIndex++;
                            }
                            // Ensure the current word is a string, and never undefined
                            if (!builtNames[currentNameIndex]) {
                                builtNames[currentNameIndex] = '';
                            }
                            builtNames[currentNameIndex] += ' ' + word.text;
                        });
                    });
                    // HACK There was a case where the first item is undefined, because it's baseline was strange or so
                    // This prevents it for now, but i gotta see why that happened
                    builtNames = builtNames.filter(builtName => builtName !== undefined);
                    ApiConnector.processItemNames(builtNames, store, [
                        // temporaryScreenshotNameRaw, temporaryScreenshotNameCropped
                    ]);
                });
            });
        });
    }
}