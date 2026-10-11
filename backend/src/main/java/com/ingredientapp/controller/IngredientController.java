package com.ingredientapp.controller;

import com.ingredientapp.dto.ImageRequest;
import com.ingredientapp.dto.ManualIngredientRequest;
import com.ingredientapp.model.Ingredient;
import com.ingredientapp.model.Recipe;
import com.ingredientapp.model.RecipeDetail;
import com.ingredientapp.service.ApiRateLimitedException;
import com.ingredientapp.service.ApiUnavailableException;
import com.ingredientapp.service.GeminiService;
import com.ingredientapp.service.SpoonacularService;
import jakarta.servlet.http.HttpSession;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/* Main REST endpoints: scan an ingredient, view/add/remove ingredients, and get recipes.
   Ingredients are kept per-session in memory, no database. */
@RestController
@RequestMapping("/api")
public class IngredientController {

    private static final String SESSION_ATTRIBUTE = "ingredients";

    private final GeminiService geminiService;
    private final SpoonacularService spoonacularService;

    public IngredientController(GeminiService geminiService, SpoonacularService spoonacularService) {
        this.geminiService = geminiService;
        this.spoonacularService = spoonacularService;
    }

    @PostMapping("/detect-ingredients")
    public ResponseEntity<?> detectIngredients(@RequestBody ImageRequest request, HttpSession session) {
        List<Ingredient> detected;
        try {
            detected = geminiService.detectIngredients(request.getImage());
        } catch (ApiRateLimitedException e) {
            // 429 so the front-end knows it's a quota issue, not just no ingredients found
            return ResponseEntity.status(429).body(Map.of(
                    "error", "rate_limited",
                    "message", e.getMessage()
            ));
        } catch (ApiUnavailableException e) {
            // 503: the service is down, not a problem with the photo
            return ResponseEntity.status(503).body(Map.of(
                    "error", "service_unavailable",
                    "message", e.getMessage()
            ));
        }
        List<Ingredient> sessionIngredients = getSessionIngredients(session);

        for (Ingredient newIngredient : detected) {
            boolean alreadyPresent = sessionIngredients.stream()
                    .anyMatch(existing -> existing.getName().equalsIgnoreCase(newIngredient.getName()));
            if (!alreadyPresent) {
                sessionIngredients.add(newIngredient);
            }
        }

        session.setAttribute(SESSION_ATTRIBUTE, sessionIngredients);
        return ResponseEntity.ok(sessionIngredients);
    }

    @GetMapping("/ingredients")
    public ResponseEntity<List<Ingredient>> getIngredients(HttpSession session) {
        return ResponseEntity.ok(getSessionIngredients(session));
    }

    @PostMapping("/ingredients")
    public ResponseEntity<?> addIngredient(@RequestBody ManualIngredientRequest request, HttpSession session) {
        String rawName = request.getName() == null ? "" : request.getName().trim();
        if (rawName.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "Ingredient name cannot be empty."
            ));
        }
        // needs to be final so the lambda below can use it
        final String name = rawName.length() > 40 ? rawName.substring(0, 40) : rawName;

        try {
            if (!spoonacularService.isRecognisedIngredient(name)) {
                return ResponseEntity.badRequest().body(Map.of(
                        "error", "\"" + name + "\" isn't recognised as an ingredient. Check the spelling, "
                                + "or try a simpler name, for example \"chicken\" instead of a brand name."
                ));
            }
        } catch (ApiRateLimitedException e) {
            return ResponseEntity.status(429).body(Map.of(
                    "error", "rate_limited",
                    "message", e.getMessage()
            ));
        }

        List<Ingredient> sessionIngredients = getSessionIngredients(session);
        boolean alreadyPresent = sessionIngredients.stream()
                .anyMatch(existing -> existing.getName().equalsIgnoreCase(name));
        if (!alreadyPresent) {
            // 1.0 confidence since the user typed it themselves
            sessionIngredients.add(new Ingredient(name, 1.0));
        }

        session.setAttribute(SESSION_ATTRIBUTE, sessionIngredients);
        return ResponseEntity.ok(sessionIngredients);
    }

    @DeleteMapping("/ingredients/{name}")
    public ResponseEntity<List<Ingredient>> removeIngredient(@PathVariable String name, HttpSession session) {
        List<Ingredient> sessionIngredients = getSessionIngredients(session);
        sessionIngredients.removeIf(i -> i.getName().equalsIgnoreCase(name));
        session.setAttribute(SESSION_ATTRIBUTE, sessionIngredients);
        return ResponseEntity.ok(sessionIngredients);
    }

    @GetMapping("/recipes")
    public ResponseEntity<?> getRecipes(HttpSession session) {
        List<Ingredient> sessionIngredients = getSessionIngredients(session);
        if (sessionIngredients.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "No ingredients in this session yet. Scan at least one ingredient first."
            ));
        }
        try {
            List<Recipe> recipes = spoonacularService.findRecipes(sessionIngredients);
            return ResponseEntity.ok(recipes);
        } catch (ApiRateLimitedException e) {
            return ResponseEntity.status(429).body(Map.of(
                    "error", "rate_limited",
                    "message", e.getMessage()
            ));
        }
    }

    @GetMapping("/recipes/{id}")
    public ResponseEntity<?> getRecipeDetail(@PathVariable int id, HttpSession session) {
        List<Ingredient> sessionIngredients = getSessionIngredients(session);
        RecipeDetail detail;
        try {
            detail = spoonacularService.getRecipeDetail(id, sessionIngredients);
        } catch (ApiRateLimitedException e) {
            return ResponseEntity.status(429).body(Map.of(
                    "error", "rate_limited",
                    "message", e.getMessage()
            ));
        }
        if (detail == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(detail);
    }

    @SuppressWarnings("unchecked")
    private List<Ingredient> getSessionIngredients(HttpSession session) {
        Object attribute = session.getAttribute(SESSION_ATTRIBUTE);
        if (attribute == null) {
            List<Ingredient> fresh = new ArrayList<>();
            session.setAttribute(SESSION_ATTRIBUTE, fresh);
            return fresh;
        }
        return (List<Ingredient>) attribute;
    }
}
